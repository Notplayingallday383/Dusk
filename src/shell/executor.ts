import { type CompoundList, type Pipeline, type Command, type Redirect } from './parser';
import { builtins, isBuiltin, decodeUtf8, encodeUtf8, readFileText, writeFileText, type ShellState } from './builtins';

export interface ExecResult {
  stdout: Uint8Array;
  stderr: Uint8Array;
  status: number;
}

interface ExecOptions {
  input?: Uint8Array | undefined;
  captureStdout?: boolean | undefined;
  captureStderr?: boolean | undefined;
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

const lookupSpecial = (name: string, state: ShellState): string | null => {
  if (name === '?') return state.exitCode.toString();
  if (name === '#') {
    const n = state.positional.length - 1;
    return (n < 0 ? 0 : n).toString();
  }
  if (name === '@' || name === '*') return state.positional.slice(1).join(' ');
  if (/^[0-9]+$/.test(name)) {
    const idx = parseInt(name, 10);
    return state.positional[idx] ?? '';
  }
  return null;
};

const expandWord = (word: string, state: ShellState): string => {
  const env = state.env;
  let out = '';
  let i = 0;
  while (i < word.length) {
    const c = word[i]!;
    if (c === '$') {
      if (word[i + 1] === '{') {
        const end = word.indexOf('}', i + 2);
        if (end === -1) { out += c; i++; continue; }
        const name = word.slice(i + 2, end);
        const sp = lookupSpecial(name, state);
        out += sp !== null ? sp : (env[name] ?? '');
        i = end + 1;
      } else {
        const next = word[i + 1];
        if (next !== undefined && (next === '?' || next === '#' || next === '@' || next === '*' || /[0-9]/.test(next))) {
          const sp = lookupSpecial(next, state);
          out += sp ?? '';
          i += 2;
          continue;
        }
        let j = i + 1;
        while (j < word.length && /[A-Za-z0-9_]/.test(word[j]!)) j++;
        if (j === i + 1) { out += c; i++; continue; }
        const name = word.slice(i + 1, j);
        out += env[name] ?? '';
        i = j;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
};

const expandCommand = (cmd: Command, state: ShellState): Command => ({
  words: cmd.words.map((w) => expandWord(w, state)),
  redirects: cmd.redirects.map((r) => ({ type: r.type, target: expandWord(r.target, state) })),
});

const resolveExternal = (cmd: string, env: Record<string, string>): string | null => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { exists: (p: string) => boolean } | undefined;
  if (cmd.startsWith('/') || cmd.startsWith('./') || cmd.startsWith('../')) {
    if (!fs) return cmd;
    try { if (fs.exists(cmd)) return cmd; } catch { /* fall through */ }
    return cmd;
  }
  if (!fs) return null;
  const pathEnv = env['PATH'] ?? '/bin';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = (dir.endsWith('/') ? dir : dir + '/') + cmd;
    try { if (fs.exists(candidate)) return candidate; } catch { /* skip */ }
  }
  return null;
};

const applyOutputRedirects = (redirects: Redirect[], stdout: Uint8Array): Uint8Array => {
  let current = stdout;
  for (const r of redirects) {
    if (r.type === '>') {
      writeFileText(r.target, decodeUtf8(current));
      current = new Uint8Array(0);
    } else if (r.type === '>>') {
      let existing = '';
      try { existing = readFileText(r.target); } catch { existing = ''; }
      writeFileText(r.target, existing + decodeUtf8(current));
      current = new Uint8Array(0);
    }
  }
  return current;
};

const loadInputRedirect = (redirects: Redirect[], fallback: Uint8Array | undefined): Uint8Array | undefined => {
  let input = fallback;
  for (const r of redirects) {
    if (r.type === '<') {
      const text = readFileText(r.target);
      input = encodeUtf8(text);
    }
  }
  return input;
};

const runCommand = (cmd: Command, state: ShellState, opts: ExecOptions): ExecResult => {
  const expanded = expandCommand(cmd, state);
  const words = expanded.words;
  if (words.length === 0) return { stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: 0 };

  const prog = words[0]!;
  const args = words.slice(1);
  const input = loadInputRedirect(expanded.redirects, opts.input);

  if (isBuiltin(prog)) {
    const io = { stdout: [] as Uint8Array[], stderr: [] as Uint8Array[], stdin: input ?? new Uint8Array(0) };
    let status = 0;
    try {
      status = builtins[prog]!(args, state, io);
    } catch (e) {
      io.stderr.push(encodeUtf8(String(e) + '\n'));
      status = 1;
    }
    state.exitCode = status;
    const finalStdout = applyOutputRedirects(expanded.redirects, concat(io.stdout));
    return { stdout: finalStdout, stderr: concat(io.stderr), status };
  }

  const resolved = resolveExternal(prog, state.env);
  if (!resolved) {
    const msg = encodeUtf8(`${prog}: command not found\n`);
    state.exitCode = 127;
    return { stdout: new Uint8Array(0), stderr: msg, status: 127 };
  }

  const cp = (globalThis as Record<string, unknown>)['require'] as ((m: string) => { spawnSync: (c: string, a: string[], o?: Record<string, unknown>) => { stdout: Uint8Array; stderr: Uint8Array; status: number } }) | undefined;
  if (!cp) {
    state.exitCode = 1;
    return { stdout: new Uint8Array(0), stderr: encodeUtf8('require(child_process) not available\n'), status: 1 };
  }
  let childResult;
  try {
    const mod = cp('child_process');
    const spawnOpts: Record<string, unknown> = { env: state.env, cwd: state.cwd };
    if (input) spawnOpts['stdin'] = Array.from(input);
    childResult = mod.spawnSync(resolved, args, spawnOpts);
  } catch (e) {
    state.exitCode = 1;
    return { stdout: new Uint8Array(0), stderr: encodeUtf8(String(e) + '\n'), status: 1 };
  }
  const finalStdout = applyOutputRedirects(expanded.redirects, childResult.stdout);
  state.exitCode = childResult.status;
  return { stdout: finalStdout, stderr: childResult.stderr, status: childResult.status };
};

const runPipeline = (pipeline: Pipeline, state: ShellState): ExecResult => {
  if (pipeline.commands.length === 1) {
    const result = runCommand(pipeline.commands[0]!, state, {});
    if (result.stdout.length > 0) emitStdout(result.stdout);
    if (result.stderr.length > 0) emitStderr(result.stderr);
    return result;
  }
  let lastStdout: Uint8Array = new Uint8Array(0);
  let lastStatus = 0;
  for (let i = 0; i < pipeline.commands.length; i++) {
    const isLast = i === pipeline.commands.length - 1;
    const cmd = pipeline.commands[i]!;
    const result = runCommand(cmd, state, { input: i === 0 ? undefined : lastStdout });
    if (result.stderr.length > 0) emitStderr(result.stderr);
    if (isLast) {
      if (result.stdout.length > 0) emitStdout(result.stdout);
      lastStatus = result.status;
    } else {
      lastStdout = result.stdout;
      lastStatus = result.status;
    }
  }
  return { stdout: new Uint8Array(0), stderr: new Uint8Array(0), status: lastStatus };
};

const emitStdout = (data: Uint8Array): void => {
  const proc = (globalThis as Record<string, unknown>)['process'] as { stdout?: { write: (d: Uint8Array) => void } } | undefined;
  if (proc?.stdout) proc.stdout.write(data);
};

const emitStderr = (data: Uint8Array): void => {
  const proc = (globalThis as Record<string, unknown>)['process'] as { stderr?: { write: (d: Uint8Array) => void } } | undefined;
  if (proc?.stderr) proc.stderr.write(data);
};

export const execute = (ast: CompoundList, state: ShellState): number => {
  let lastStatus = state.exitCode;
  let prevOperator: '&&' | '||' | ';' | undefined;
  for (const entry of ast.pipelines) {
    if (prevOperator === '&&' && lastStatus !== 0) {
      prevOperator = entry.operator;
      continue;
    }
    if (prevOperator === '||' && lastStatus === 0) {
      prevOperator = entry.operator;
      continue;
    }
    if (state.exitRequested) break;
    const result = runPipeline(entry.pipeline, state);
    lastStatus = result.status;
    state.exitCode = lastStatus;
    prevOperator = entry.operator;
  }
  return lastStatus;
};
