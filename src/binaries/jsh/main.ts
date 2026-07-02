// /bin/jsh — DuskJS binary wrapping just-bash's Bash class.
//
// Provides ~90 commands (grep, sed, awk, find, sort, uniq, cut, cp, mv, tar,
// jq, printf, tee, base64, xargs, and more) via the just-bash npm package
// (Apache-2.0, Vercel Labs — see /NOTICE).
//
// Usage:
//   jsh -c "grep -r TODO /src"     # inline script
//   jsh                            # interactive REPL
//   jsh script.sh                  # run script file
//
// Filesystem: jsh runs against DuskJS's TFS directly via the TfsFs adapter.
// Writes are immediately visible to other binaries and persist across jsh
// invocations. Symlinks/hardlinks/chmod/utimes are degraded (TFS lacks them);
// see tfs-fs.ts for the coverage matrix.

import { Bash } from '../../vendor/just-bash/Bash';
import { TfsFs } from './tfs-fs';

type ProcessGlobal = {
  argv: string[];
  env: Record<string, string>;
  cwd: () => string;
  exit?: (n: number) => void;
  stdin?: { read: () => Uint8Array | null };
  stdout: { write: (d: string | Uint8Array) => unknown };
  stderr: { write: (d: string | Uint8Array) => unknown };
};

type FsGlobal = {
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  readdir: (path: string) => string[];
  mkdir: (path: string, recursive: boolean) => void;
  exists: (path: string) => boolean;
  stat: (path: string) => { isFile: boolean; isDirectory: boolean; size?: number };
};

const getProc = (): ProcessGlobal | undefined =>
  (globalThis as Record<string, unknown>)['process'] as ProcessGlobal | undefined;

const getFs = (): FsGlobal | undefined =>
  (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;

const readStdinSync = (): Uint8Array | null => {
  const ipc = (globalThis as { ipc?: { send: (m: unknown) => { value?: unknown; error?: string } } }).ipc;
  if (!ipc) return null;
  try {
    const r = ipc.send({ f: 'proc.readStdin' });
    if (r.error) return null;
    const v = r.value;
    if (v === null || v === undefined) return null;
    if (Array.isArray(v)) return new Uint8Array(v as number[]);
    return null;
  } catch { return null; }
};

const collectStdinAll = (): string => {
  let s = '';
  while (true) {
    const chunk = readStdinSync();
    if (chunk === null) break;
    if (chunk.length === 0) {
      // Poll gap; yield briefly. Engine setTimeout is fake so this is a no-op
      // but keeps the loop from being a hot spin under real timers.
      const deadline = Date.now() + 1;
      while (Date.now() < deadline) { /* */ }
      // If nothing new arrives on two consecutive polls, assume caller isn't
      // sending more. Break to avoid hanging waiting for close.
      const followup = readStdinSync();
      if (followup === null) break;
      if (followup.length === 0) break;
      for (let i = 0; i < followup.length; i++) s += String.fromCharCode(followup[i]!);
      continue;
    }
    for (let i = 0; i < chunk.length; i++) s += String.fromCharCode(chunk[i]!);
  }
  return s;
};

const runOnce = async (bash: Bash, script: string, stdin: string): Promise<number> => {
  const proc = getProc();
  const cwd = proc?.cwd ? proc.cwd() : '/';
  const result = await bash.exec(script, { cwd, stdin });
  if (result.stdout) proc?.stdout.write(result.stdout);
  if (result.stderr) proc?.stderr.write(result.stderr);
  return result.exitCode;
};

// Inspect a value the way node's REPL does. Not a full util.inspect, but
// enough to differentiate strings, numbers, objects, arrays, functions,
// undefined, and errors. Cycle-safe within 3 levels.
const inspect = (v: unknown, depth = 0): string => {
  if (depth > 3) return '...';
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  const t = typeof v;
  if (t === 'string') return "'" + String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'function') {
    const name = (v as { name?: string }).name;
    return '[Function: ' + (name || 'anonymous') + ']';
  }
  if (t === 'symbol') return String(v);
  if (v instanceof Error) return v.stack ? String(v.stack) : (v.name + ': ' + v.message);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    return '[ ' + v.slice(0, 100).map((x) => inspect(x, depth + 1)).join(', ') +
      (v.length > 100 ? ', ...' + (v.length - 100) + ' more' : '') + ' ]';
  }
  if (t === 'object') {
    try {
      const keys = Object.keys(v as object);
      if (keys.length === 0) return '{}';
      const parts = keys.slice(0, 50).map((k) => k + ': ' + inspect((v as Record<string, unknown>)[k], depth + 1));
      return '{ ' + parts.join(', ') + (keys.length > 50 ? ', ...' + (keys.length - 50) + ' more' : '') + ' }';
    } catch { return '[object]'; }
  }
  return String(v);
};

// A minimal node-like REPL. Persists a shared context (`replCtx`) across
// lines so users can define variables and reuse them. Supports `.exit`,
// `.help`, `.clear`, and multi-line via trailing backslash.
const runNodeRepl = async (
  stdout: { write: (d: string | Uint8Array) => unknown },
  stderr: { write: (d: string | Uint8Array) => unknown },
  readLine: () => Promise<string | null>,
): Promise<void> => {
  stdout.write('Welcome to DuskJS node REPL. Type .help for commands, .exit to leave.\n');
  // Shared eval context. We wrap in a Proxy so `with` intercepts ALL
  // identifier lookups on it — otherwise bare assignments (`y = 100`) fall
  // through to globalThis instead of landing on ctx.
  //
  // The has-trap returns true for everything, forcing `with` to route every
  // identifier through our get-trap. The get-trap first checks ctx (user
  // state), then globalThis (so `console`, `require`, `Math`, etc. still
  // resolve). The set-trap stores exclusively on ctx.
  const state: Record<string, unknown> = Object.create(null);
  const ctxProxy = new Proxy(state, {
    has(_target, _key): boolean { return true; },
    get(target, key: PropertyKey): unknown {
      if (key === Symbol.unscopables) return undefined;
      if (key in target) return (target as Record<PropertyKey, unknown>)[key];
      return (globalThis as unknown as Record<PropertyKey, unknown>)[key];
    },
    set(target, key: PropertyKey, value: unknown): boolean {
      (target as Record<PropertyKey, unknown>)[key] = value;
      return true;
    },
    deleteProperty(target, key: PropertyKey): boolean {
      return delete (target as Record<PropertyKey, unknown>)[key];
    },
  });
  const ctx = ctxProxy as unknown as Record<string, unknown>;
  let buffered = '';
  const promptPrimary = '> ';
  const promptContinue = '... ';
  while (true) {
    stdout.write(buffered.length === 0 ? promptPrimary : promptContinue);
    const line = await readLine();
    if (line === null) { stdout.write('\n'); return; }
    const raw = line;
    if (buffered.length === 0) {
      const cmd = raw.trim();
      if (cmd === '.exit' || cmd === '.quit') return;
      if (cmd === '.help') {
        stdout.write('.help    show this help\n.exit    return to jsh\n.clear   reset REPL context\n(end a line with \\ to continue on the next line)\n');
        continue;
      }
      if (cmd === '.clear') {
        for (const k of Object.keys(state)) delete state[k];
        stdout.write('context cleared.\n');
        continue;
      }
    }
    // Multi-line continuation on trailing backslash.
    if (raw.endsWith('\\')) {
      buffered += raw.slice(0, -1) + '\n';
      continue;
    }
    const code = buffered + raw;
    buffered = '';
    if (!code.trim()) continue;
    // Evaluate. Wrap in async fn so `await` at top level works. Use `with`
    // on ctx to make bare assignments (`x = 5`) persist across lines.
    //
    // Known limitation: `var`/`let`/`const` declarations and `function foo`
    // declarations scope to this eval frame and do NOT persist across lines
    // — the underlying eval runs in strict mode via `new Function`. Users
    // wanting cross-line state should assign bare (no keyword). Node's real
    // REPL rewrites source to hoist these; that's more work than we need.
    let result: unknown;
    let threw = false;
    try {
      // eslint-disable-next-line no-new-func
      const fn = new Function('__ctx', 'with (__ctx) { return (async () => { return eval(' + JSON.stringify(code) + '); })(); }');
      result = await (fn as (c: Record<string, unknown>) => Promise<unknown>)(ctx);
    } catch (e) {
      threw = true;
      stderr.write('Uncaught ' + (e instanceof Error ? (e.stack || (e.name + ': ' + e.message)) : String(e)) + '\n');
    }
    if (!threw && result !== undefined) {
      stdout.write(inspect(result) + '\n');
    }
  }
};

const runInteractive = async (bash: Bash): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  const ipc = (globalThis as { ipc?: { send: (m: unknown) => { value?: unknown; error?: string } } }).ipc;
  if (!ipc) { stderr.write('jsh: no stdin available\n'); return 1; }

  const readStdin = (): Uint8Array | null => {
    try {
      const r = ipc.send({ f: 'proc.readStdin' });
      if (r.error) return null;
      const v = r.value;
      if (v === null || v === undefined) return null;
      if (Array.isArray(v)) return new Uint8Array(v as number[]);
      return null;
    } catch { return null; }
  };
  const decode = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
    return s;
  };

  // A shared line-buffered reader so both jsh mode and node REPL mode can
  // pull one line at a time from the same stdin stream.
  let lineBuf = '';
  const readLine = async (): Promise<string | null> => {
    while (true) {
      const nl = lineBuf.indexOf('\n');
      if (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        return line;
      }
      const chunk = readStdin();
      if (chunk === null) {
        if (lineBuf.length > 0) { const rest = lineBuf; lineBuf = ''; return rest; }
        return null;
      }
      if (chunk.length === 0) {
        await new Promise<void>((r) => setTimeout(r, 5));
        continue;
      }
      lineBuf += decode(chunk);
    }
  };

  let exitCode = 0;
  while (true) {
    stdout.write('jsh$ ');
    const line = await readLine();
    if (line === null) break;
    const script = line.trim();
    if (script.length === 0) continue;
    if (script === 'exit' || script === 'quit') {
      stdout.write('\n');
      return exitCode;
    }
    // `node` (with no args) enters the interactive REPL mode. This is a
    // jsh-side hijack — the js-exec/node command in the registry only handles
    // -c/-e/file mode; interactive belongs at the shell level.
    if (script === 'node') {
      try {
        await runNodeRepl(stdout, stderr, readLine);
      } catch (e) {
        stderr.write('node: ' + String(e) + '\n');
      }
      continue;
    }
    try {
      exitCode = await runOnce(bash, script, '');
    } catch (e) {
      stderr.write('jsh: ' + String(e) + '\n');
      exitCode = 2;
    }
  }
  return exitCode;
};

export const main = async (): Promise<number> => {
  const proc = getProc();
  const fs = getFs();
  if (!proc) return 1;

  const argv = proc.argv;
  const args = argv.slice(1);

  // Parse flags: -c script, --version, -h/--help, script file.
  let scriptInline: string | null = null;
  let scriptFile: string | null = null;
  let showHelp = false;
  let showVersion = false;
  const scriptArgs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-c' && i + 1 < args.length) {
      scriptInline = args[i + 1]!;
      i++;
      // any remaining args are $0, $1, ... for the script
      for (let j = i + 1; j < args.length; j++) scriptArgs.push(args[j]!);
      break;
    } else if (a === '--version' || a === '-v') {
      showVersion = true;
    } else if (a === '--help' || a === '-h') {
      showHelp = true;
    } else if (a === '-') {
      // Read script from stdin
      scriptInline = collectStdinAll();
      break;
    } else if (!a.startsWith('-')) {
      scriptFile = a;
      for (let j = i + 1; j < args.length; j++) scriptArgs.push(args[j]!);
      break;
    }
  }

  if (showHelp) {
    proc.stdout.write('jsh — DuskJS shell (powered by just-bash)\n');
    proc.stdout.write('Usage: jsh [-c script] [script-file] [args...]\n');
    proc.stdout.write('Options:\n');
    proc.stdout.write('  -c script     Run inline script and exit\n');
    proc.stdout.write('  -             Read script from stdin\n');
    proc.stdout.write('  --version     Print version and exit\n');
    proc.stdout.write('  --help        Print this help and exit\n');
    if (proc.exit) proc.exit(0);
    return 0;
  }

  if (showVersion) {
    proc.stdout.write('jsh (DuskJS shell / just-bash) 3.0.2\n');
    if (proc.exit) proc.exit(0);
    return 0;
  }

  // Build a just-bash environment backed by DuskJS's TFS. Writes hit TFS
  // immediately and are visible to other binaries (no snapshotting).
  if (!fs) {
    proc.stderr.write('jsh: __fs global missing; TFS bridge unavailable\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }
  const jbFs = new TfsFs();

  const bash = new Bash({
    fs: jbFs,
    // Enable JS: registers `js-exec` and `node` commands that route to a
    // DuskJS-native in-engine eval (see vendor/just-bash/commands/js-exec/).
    javascript: true,
    // No network for now (libcurl bridge is DuskJS-side, not exposed to jsh yet).
    // No python — WASM CPython not integrated.
  });

  let code: number;
  if (scriptInline !== null) {
    const stdin = readStdinInline();
    code = await runOnce(bash, scriptInline, stdin);
  } else if (scriptFile !== null) {
    let content: string;
    try {
      if (!fs) throw new Error('__fs not available');
      content = fs.readFile(scriptFile);
    } catch (e) {
      proc.stderr.write('jsh: ' + scriptFile + ': ' + String(e) + '\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
    const stdin = readStdinInline();
    code = await runOnce(bash, content, stdin);
  } else {
    code = await runInteractive(bash);
  }

  if (proc.exit) proc.exit(code);
  return code;
};

// Only collect stdin bytes if there are any immediately-available chunks;
// don't block. Used for `jsh -c ...` where the caller may pipe input or not.
const readStdinInline = (): string => {
  const first = readStdinSync();
  if (first === null || first.length === 0) return '';
  let s = '';
  for (let i = 0; i < first.length; i++) s += String.fromCharCode(first[i]!);
  // Drain any additional chunks that are immediately available.
  for (let iter = 0; iter < 1000; iter++) {
    const chunk = readStdinSync();
    if (chunk === null || chunk.length === 0) break;
    for (let i = 0; i < chunk.length; i++) s += String.fromCharCode(chunk[i]!);
  }
  return s;
};
