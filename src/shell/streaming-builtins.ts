import type { ShellState } from './scope';

export interface StreamingBuiltinIo {
  stdinStream: AsyncIterable<Uint8Array>;
  writeStdout: (chunk: Uint8Array) => Promise<void>;
  writeStderr: (chunk: Uint8Array) => Promise<void>;
  signalEof: () => void; // closes stdout downstream
}

export type StreamingBuiltin = (
  args: string[], state: ShellState, io: StreamingBuiltinIo,
) => Promise<number>;

// Engine lacks TextEncoder in some paths; implement inline to avoid coupling.
const encode = (s: string): Uint8Array => {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
  return bytes;
};

const isEpipe = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { code?: string }).code === 'EPIPE';

const yesBuiltin: StreamingBuiltin = async (args, _state, io) => {
  const text = (args.length > 0 ? args.join(' ') : 'y') + '\n';
  const chunk = encode(text);
  while (true) {
    try {
      await io.writeStdout(chunk);
    } catch (e) {
      if (isEpipe(e)) return 141;
      throw e;
    }
  }
};

const trueBuiltin: StreamingBuiltin = async (_args, _state, _io) => 0;
const falseBuiltin: StreamingBuiltin = async (_args, _state, _io) => 1;

// NOTE: engine setTimeout is a fake (fires within current job drain, no real
// delay). See docs/superpowers/plans/2026-06-30-duskjs-decisions.md landmines.
// We preserve the exit-code contract (0 for valid arg, 1 for invalid) which is
// what pipelines rely on; the delay is effectively a no-op in-engine.
const sleepBuiltin: StreamingBuiltin = async (args, _state, _io) => {
  const secs = parseFloat(args[0] ?? '0');
  if (isNaN(secs) || secs < 0) return 1;
  await new Promise((r) => setTimeout(r, Math.round(secs * 1000)));
  return 0;
};

const catBuiltin: StreamingBuiltin = async (_args, _state, io) => {
  for await (const chunk of io.stdinStream) {
    try {
      await io.writeStdout(chunk);
    } catch (e) {
      if (isEpipe(e)) return 141;
      throw e;
    }
  }
  return 0;
};

const headBuiltin: StreamingBuiltin = async (args, _state, io) => {
  // Supported: head -n N, head -c N. Default: head -n 10.
  let mode: 'lines' | 'bytes' = 'lines';
  let limit = 10;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-n' && i + 1 < args.length) { mode = 'lines'; limit = parseInt(args[++i]!, 10); }
    else if (args[i] === '-c' && i + 1 < args.length) { mode = 'bytes'; limit = parseInt(args[++i]!, 10); }
  }
  if (isNaN(limit) || limit < 0) return 1;

  let linesEmitted = 0;
  let bytesEmitted = 0;
  outer: for await (const chunk of io.stdinStream) {
    if (mode === 'bytes') {
      const remaining = limit - bytesEmitted;
      if (remaining <= 0) break;
      const slice = chunk.length <= remaining ? chunk : chunk.subarray(0, remaining);
      bytesEmitted += slice.length;
      try { await io.writeStdout(slice); } catch (e) { if (isEpipe(e)) return 141; throw e; }
      if (bytesEmitted >= limit) break;
    } else {
      // line mode: emit until we've seen `limit` newlines
      const start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === 0x0a) {
          linesEmitted++;
          if (linesEmitted >= limit) {
            const slice = chunk.subarray(start, i + 1);
            try { await io.writeStdout(slice); } catch (e) { if (isEpipe(e)) return 141; throw e; }
            break outer;
          }
        }
      }
      try { await io.writeStdout(chunk.subarray(start)); } catch (e) { if (isEpipe(e)) return 141; throw e; }
    }
  }
  return 0;
};

const wcBuiltin: StreamingBuiltin = async (args, _state, io) => {
  let mode: 'lines' | 'bytes' | 'words' | 'all' = 'all';
  if (args.includes('-l')) mode = 'lines';
  else if (args.includes('-c')) mode = 'bytes';
  else if (args.includes('-w')) mode = 'words';

  let lines = 0;
  let bytes = 0;
  let words = 0;
  let inWord = false;
  for await (const chunk of io.stdinStream) {
    bytes += chunk.length;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      if (c === 0x0a) lines++;
      const isSpace = c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
      if (isSpace) { if (inWord) { words++; inWord = false; } }
      else { inWord = true; }
    }
  }
  if (inWord) words++;

  let result: string;
  if (mode === 'lines') result = `${lines}\n`;
  else if (mode === 'bytes') result = `${bytes}\n`;
  else if (mode === 'words') result = `${words}\n`;
  else result = `${lines} ${words} ${bytes}\n`;
  try { await io.writeStdout(encode(result)); } catch (e) { if (isEpipe(e)) return 141; throw e; }
  return 0;
};

const trBuiltin: StreamingBuiltin = async (args, _state, io) => {
  if (args.length < 2) return 1;
  const expand = (spec: string): string => {
    let out = '';
    let i = 0;
    while (i < spec.length) {
      if (i + 2 < spec.length && spec[i + 1] === '-') {
        const a = spec.charCodeAt(i);
        const b = spec.charCodeAt(i + 2);
        for (let c = a; c <= b; c++) out += String.fromCharCode(c);
        i += 3;
      } else {
        out += spec[i]!;
        i++;
      }
    }
    return out;
  };
  const from = expand(args[0]!);
  const to = expand(args[1]!);
  const map = new Map<number, number>();
  for (let i = 0; i < from.length; i++) {
    const tgt = to[Math.min(i, to.length - 1)];
    if (tgt !== undefined) map.set(from.charCodeAt(i), tgt.charCodeAt(0));
  }
  for await (const chunk of io.stdinStream) {
    const out = new Uint8Array(chunk.length);
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]!;
      out[i] = map.has(c) ? map.get(c)! : c;
    }
    try { await io.writeStdout(out); } catch (e) { if (isEpipe(e)) return 141; throw e; }
  }
  return 0;
};

const seqBuiltin: StreamingBuiltin = async (args, _state, io) => {
  let start = 1, step = 1, end = 1;
  if (args.length === 1) { end = parseInt(args[0]!, 10); }
  else if (args.length === 2) { start = parseInt(args[0]!, 10); end = parseInt(args[1]!, 10); }
  else if (args.length >= 3) { start = parseInt(args[0]!, 10); step = parseInt(args[1]!, 10); end = parseInt(args[2]!, 10); }
  if ([start, step, end].some(isNaN) || step === 0) return 1;
  // Buffer output in modest chunks to avoid per-line overhead
  let buf = '';
  const flush = async (): Promise<boolean> => {
    if (buf.length === 0) return true;
    try { await io.writeStdout(encode(buf)); buf = ''; return true; }
    catch (e) { if (isEpipe(e)) return false; throw e; }
  };
  const ascending = step > 0;
  for (let n = start; ascending ? n <= end : n >= end; n += step) {
    buf += `${n}\n`;
    if (buf.length >= 8192) { if (!await flush()) return 141; }
  }
  if (!await flush()) return 141;
  return 0;
};

export const streamingBuiltins: Record<string, StreamingBuiltin> = {
  yes: yesBuiltin,
  true: trueBuiltin,
  false: falseBuiltin,
  sleep: sleepBuiltin,
  cat: catBuiltin,
  head: headBuiltin,
  wc: wcBuiltin,
  tr: trBuiltin,
  seq: seqBuiltin,
};
