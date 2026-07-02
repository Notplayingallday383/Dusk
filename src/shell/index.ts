import { tokenize } from './tokenizer';
import { parse } from './parser';
import { execute } from './executor';
import { type ShellState } from './builtins';

export { tokenize } from './tokenizer';
export { parse } from './parser';
export { execute } from './executor';
export type { ShellState } from './builtins';

export const runShellScript = (script: string, initial?: Partial<ShellState>): number => {
  const state: ShellState = {
    cwd: initial?.cwd ?? '/',
    env: { ...(initial?.env ?? {}) },
    exitCode: 0,
    exitRequested: false,
    exitRequestedCode: 0,
    positional: initial?.positional ?? ['sh'],
  };
  try {
    const tokens = tokenize(script);
    const ast = parse(tokens);
    const code = execute(ast, state);
    return state.exitRequested ? state.exitRequestedCode : code;
  } catch (e) {
    const proc = (globalThis as Record<string, unknown>)['process'] as { stderr?: { write: (d: string) => void } } | undefined;
    if (proc?.stderr) proc.stderr.write('sh: ' + String(e) + '\n');
    return 2;
  }
};

// shell-v2: opt-in async runner. Use the same runShellScriptV2 to run a script
// through the v2 tokenizer/parser/executor.
export const runShellScriptV2 = async (
  script: string,
  initial?: { cwd?: string; env?: Record<string, string>; positional?: string[]; scriptName?: string },
): Promise<number> => {
  const { tokenize: tokenizeV2 } = await import('./tokenizer-v2');
  const { parse: parseV2 } = await import('./parser-v2');
  const { execute: executeV2 } = await import('./executor-v2');
  const { createInitialState } = await import('./scope');
  const state = createInitialState({
    cwd: initial?.cwd ?? '/',
    env: initial?.env ?? {},
    positional: initial?.positional ?? ['sh'],
    scriptName: initial?.scriptName ?? 'sh',
  } as Parameters<typeof createInitialState>[0]);
  try {
    const { tokens, heredocs } = tokenizeV2(script);
    const ast = parseV2(tokens, heredocs);
    return await executeV2(ast, state);
  } catch (e) {
    const proc = (globalThis as Record<string, unknown>)['process'] as { stderr?: { write: (d: string) => void } } | undefined;
    if (proc?.stderr) proc.stderr.write('sh: ' + String(e) + '\n');
    return 2;
  }
};

export const main = async (): Promise<number> => {
  const proc = (globalThis as Record<string, unknown>)['process'] as {
    argv: string[];
    env: Record<string, string>;
    cwd: () => string;
    exit?: (n: number) => void;
    stdin?: { read: () => Uint8Array | null };
    stdout?: { write: (d: string | Uint8Array) => unknown };
    stderr?: { write: (d: string | Uint8Array) => unknown };
  } | undefined;
  const argv = proc?.argv ?? ['/bin/sh'];
  const env = { ...(proc?.env ?? {}) };
  let cwd = proc?.cwd ? proc.cwd() : '/';

  const dashCIdx = argv.indexOf('-c');
  if (dashCIdx !== -1 && dashCIdx + 1 < argv.length) {
    const script = argv[dashCIdx + 1]!;
    const trailing = argv.slice(dashCIdx + 2);
    const positional = trailing.length > 0 ? trailing : ['sh'];
    let code: number;
    // shell-v2 is now the default; opt out with DUSK_SHELL_V1=1.
    const useV1 = proc?.env?.['DUSK_SHELL_V1'] === '1';
    if (useV1) {
      code = runShellScript(script, { cwd, env, positional });
    } else {
      code = await runShellScriptV2(script, { cwd, env, positional });
    }
    if (proc?.exit) proc.exit(code);
    return code;
  }

  // Non-flag first argument = script path — dispatch to node-fs read + run.
  // (Not yet implemented; fall through to interactive if no such arg.)
  const positional = argv.slice(1).filter((a) => !a.startsWith('-'));
  if (positional.length > 0) {
    if (proc?.stderr) proc.stderr.write('sh: script file execution not implemented\n');
    if (proc?.exit) proc.exit(1);
    return 1;
  }

  // Interactive REPL mode: no -c, no script argument. Read lines from stdin,
  // run each through runShellScriptV2, print prompt, loop until EOF (stdin
  // closed) or exit builtin runs. Prompt is minimalist ('$ '); no line editing
  // (no history, no cursor movement) — the browser/terminal handles that.
  // Interactive shell reads stdin via a raw `proc.readStdin` IPC poll instead
  // of `process.stdin.read()`. When stdio is a TTY, `process.stdin` is a
  // node:stream Readable that never has data pushed into it (no `_read()`
  // implementation drains from IPC), so its `.read()` always returns null.
  // The shell needs synchronous polling semantics; `proc.readStdin` provides
  // them: returns a byte array (0-length = idle) or null (EOF).
  const ipcRaw = (globalThis as {
    ipc?: { send: (m: unknown) => { value?: unknown; error?: string } };
  }).ipc;
  const stdout = proc?.stdout;
  if (!ipcRaw || !stdout) {
    if (proc?.stderr) proc.stderr.write('sh: no stdio available\n');
    if (proc?.exit) proc.exit(1);
    return 1;
  }
  const readStdinRaw = (): Uint8Array | null => {
    try {
      const r = ipcRaw.send({ f: 'proc.readStdin' });
      if (r.error) return null;
      const v = r.value;
      if (v === null || v === undefined) return null;
      if (Array.isArray(v)) return new Uint8Array(v as number[]);
      return null;
    } catch { return null; }
  };

  // Line accumulator across read() polls. proc.stdin.read() returns:
  //   Uint8Array with bytes when data available
  //   Uint8Array of length 0 when stdin open but idle
  //   null when stdin closed (EOF)
  //
  // Engine has no TextDecoder — decode bytes via String.fromCharCode
  // (utf-8-safe for ASCII input; multi-byte sequences on line boundaries
  // may split a codepoint, but shell input is overwhelmingly ASCII).
  const decodeBytes = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  };
  let lineBuf = '';
  let exitCode = 0;
  let done = false;

  stdout.write('$ ');

  while (!done) {
    const chunk = readStdinRaw();
    if (chunk === null) {
      // EOF — flush any trailing partial line, then exit.
      if (lineBuf.length > 0) {
        exitCode = await runShellScriptV2(lineBuf, { cwd, env, positional: ['sh'] });
      }
      done = true;
      break;
    }
    if (chunk.length === 0) {
      // No data yet; yield and poll again. `setTimeout` is fake in the engine
      // (fires immediately during drainJobQueue) but the await gives the host
      // dispatch loop a chance to push more stdin envelopes.
      await new Promise<void>((r) => setTimeout(r, 5));
      continue;
    }
    lineBuf += decodeBytes(chunk);
    // Split on \n; execute complete lines, keep the tail as new lineBuf.
    let nl = lineBuf.indexOf('\n');
    while (nl !== -1) {
      const raw = lineBuf.slice(0, nl);
      lineBuf = lineBuf.slice(nl + 1);
      const script = raw.trim();
      if (script.length > 0) {
        try {
          exitCode = await runShellScriptV2(script, { cwd, env, positional: ['sh'] });
        } catch (e) {
          if (proc?.stderr) proc.stderr.write('sh: ' + String(e) + '\n');
          exitCode = 2;
        }
        // Refresh cwd from process.cwd() in case the script cd'd. (v2's
        // cd builtin updates the state's cwd inside runShellScriptV2 but
        // the change doesn't survive back into main's local; re-read.)
        cwd = proc.cwd ? proc.cwd() : cwd;
      }
      stdout.write('$ ');
      nl = lineBuf.indexOf('\n');
    }
  }

  if (proc?.exit) proc.exit(exitCode);
  return exitCode;
};
