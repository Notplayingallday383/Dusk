import { type Redirect } from './parser';

export interface ShellState {
  cwd: string;
  env: Record<string, string>;
  exitCode: number;
  exitRequested: boolean;
  exitRequestedCode: number;
  positional: string[];
}

export interface BuiltinIO {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
  stdin: Uint8Array;
}

const encodeUtf8 = (str: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) { out.push(c); }
    else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
    } else { out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f)); }
  }
  return new Uint8Array(out);
};

const normPath = (p: string): string => {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
};

export type Builtin = (args: string[], state: ShellState, io: BuiltinIO) => number;

export const builtins: Record<string, Builtin> = {
  ':': () => 0,
  'true': () => 0,
  'false': () => 1,
  cd: (args, state) => {
    const target = args[0] ?? state.env['HOME'] ?? '/';
    const joined = target.startsWith('/') ? target : state.cwd.replace(/\/$/, '') + '/' + target;
    state.cwd = normPath(joined);
    return 0;
  },
  pwd: (_args, state, io) => {
    io.stdout.push(encodeUtf8(state.cwd + '\n'));
    return 0;
  },
  echo: (args, _state, io) => {
    let newline = true;
    let start = 0;
    if (args[0] === '-n') { newline = false; start = 1; }
    const parts = args.slice(start).join(' ');
    io.stdout.push(encodeUtf8(newline ? parts + '\n' : parts));
    return 0;
  },
  exit: (args, state) => {
    const code = args.length > 0 ? parseInt(args[0]!, 10) : state.exitCode;
    state.exitRequested = true;
    state.exitRequestedCode = isNaN(code) ? 0 : code;
    return state.exitRequestedCode;
  },
  export: (args, state, io) => {
    if (args.length === 0) {
      for (const key of Object.keys(state.env)) {
        io.stdout.push(encodeUtf8(`export ${key}=${state.env[key]}\n`));
      }
      return 0;
    }
    for (const arg of args) {
      const eqIdx = arg.indexOf('=');
      if (eqIdx === -1) {
        if (!(arg in state.env)) state.env[arg] = '';
      } else {
        state.env[arg.slice(0, eqIdx)] = arg.slice(eqIdx + 1);
      }
    }
    return 0;
  },
  env: (_args, state, io) => {
    for (const key of Object.keys(state.env)) {
      io.stdout.push(encodeUtf8(`${key}=${state.env[key]}\n`));
    }
    return 0;
  },
  unset: (args, state) => {
    for (const a of args) delete state.env[a];
    return 0;
  },
};

export const isBuiltin = (cmd: string): boolean => Object.prototype.hasOwnProperty.call(builtins, cmd);

export const applyRedirectsForOutput = (
  redirects: Redirect[],
  out: Uint8Array,
  err: Uint8Array,
): { stdout: Uint8Array; stderr: Uint8Array } => {
  let finalStdout = out;
  for (const r of redirects) {
    if (r.type === '>') {
      writeFileBytes(r.target, finalStdout);
      finalStdout = new Uint8Array(0);
    } else if (r.type === '>>') {
      let existing = '';
      try { existing = readFileText(r.target); } catch { existing = ''; }
      const merged = existing + decodeUtf8(finalStdout);
      writeFileText(r.target, merged);
      finalStdout = new Uint8Array(0);
    }
  }
  return { stdout: finalStdout, stderr: err };
};

export const readFileText = (path: string): string => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { readFile: (p: string) => string } | undefined;
  if (!fs) throw new Error('__fs not available');
  return fs.readFile(path);
};

export const writeFileText = (path: string, data: string): void => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { writeFile: (p: string, d: string) => void } | undefined;
  if (!fs) throw new Error('__fs not available');
  fs.writeFile(path, data);
};

export const writeFileBytes = (path: string, data: Uint8Array): void => {
  writeFileText(path, decodeUtf8(data));
};

export const decodeUtf8 = (bytes: Uint8Array): string => {
  let s = '';
  let i = 0;
  while (i < bytes.length) {
    const b1 = bytes[i++]!;
    if (b1 < 0x80) {
      s += String.fromCharCode(b1);
    } else if (b1 < 0xc0) {
      s += '\ufffd';
    } else if (b1 < 0xe0) {
      const b2 = bytes[i++] ?? 0;
      s += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
    } else if (b1 < 0xf0) {
      const b2 = bytes[i++] ?? 0;
      const b3 = bytes[i++] ?? 0;
      s += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
    } else {
      const b2 = bytes[i++] ?? 0;
      const b3 = bytes[i++] ?? 0;
      const b4 = bytes[i++] ?? 0;
      const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      const off = cp - 0x10000;
      s += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff));
    }
  }
  return s;
};

export { encodeUtf8 };
