// /bin/c — C interpreter on the host.
//
// Usage:
//   c -c "printf(\"hi\");"           inline code
//   c script.c [args...]             run TFS-resident script
//   c -                              read code from stdin
//   echo 'printf("1");' | c          same
//   c --version
//
// Heavy lifting (C interpretation) is done on the host; see src/host/c-interpreter.ts.
// TFS integration: scripts are read from TFS and executed.

type ProcessGlobal = {
  argv: string[];
  env: Record<string, string>;
  cwd: () => string;
  exit?: (n: number) => void;
  stdin?: { read: () => Uint8Array | null };
  stdout: { write: (d: string | Uint8Array) => unknown };
  stderr: { write: (d: string | Uint8Array) => unknown };
};

const getProc = (): ProcessGlobal | undefined =>
  (globalThis as Record<string, unknown>)['process'] as ProcessGlobal | undefined;

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('ipc unavailable');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

type FsGlobal = {
  readFile: (p: string) => string;
  exists: (p: string) => boolean;
};
const getFs = (): FsGlobal | undefined => (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;

const readStdinAll = (): string => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) return '';
  let s = '';
  for (let iter = 0; iter < 100000; iter++) {
    const r = ipc.send({ f: 'proc.readStdin' });
    const v = r.value;
    if (v === null || v === undefined) break;
    if (!Array.isArray(v)) break;
    if (v.length === 0) {
      if (s.length > 0) break;
      break;
    }
    for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  }
  return s;
};

export const main = async (): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;

  const argv = proc.argv.slice(1);

  let inlineCode: string | null = null;
  let scriptPath: string | null = null;
  let readStdin = false;
  const scriptArgs: string[] = [];
  let showVersion = false;
  let showHelp = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '-c' && i + 1 < argv.length) {
      inlineCode = argv[i + 1]!;
      for (let j = i + 2; j < argv.length; j++) scriptArgs.push(argv[j]!);
      break;
    }
    if (a === '--version' || a === '-V') { showVersion = true; i = argv.length; break; }
    if (a === '--help' || a === '-h') { showHelp = true; i = argv.length; break; }
    if (a === '-') { readStdin = true; for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!); break; }
    if (a.startsWith('-') && a.length > 1) {
      proc.stderr.write('c: unrecognized option: ' + a + '\n');
      if (proc.exit) proc.exit(2);
      return 2;
    }
    scriptPath = a;
    for (let j = i + 1; j < argv.length; j++) scriptArgs.push(argv[j]!);
    break;
  }

  if (showHelp) {
    proc.stdout.write([
      'c — C interpreter (proof-of-concept)',
      'Usage: c [OPTIONS] [-c CODE | SCRIPT | -] [args...]',
      '  -c CODE      Execute CODE as C',
      '  -            Read script from stdin',
      '  SCRIPT       Path in TFS to a .c file',
      '  --version    Print interpreter version and exit',
      '  --help       Print this help',
      '',
      'Supported C features:',
      '  - Basic types: int, float, char',
      '  - stdio: printf(), putchar()',
      '  - Control flow: if, while, for',
      '  - Operators: +, -, *, /, ==, !=, <, >, <=, >=',
      '',
    ].join('\n'));
    if (proc.exit) proc.exit(0);
    return 0;
  }

  if (showVersion) {
    try {
      const r = call('c.version') as { version: string };
      proc.stdout.write(r.version + '\n');
      if (proc.exit) proc.exit(0);
      return 0;
    } catch (e) {
      proc.stderr.write('c: ' + (e instanceof Error ? e.message : String(e)) + '\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
  }

  // Check for piped stdin
  if (inlineCode === null && scriptPath === null && !readStdin) {
    const piped = readStdinAll();
    if (piped.trim().length > 0) {
      const argvForC = ['c', ...scriptArgs];
      const r = call('c.exec', { code: piped, argv: argvForC }) as { stdout: string; stderr: string; exitCode: number };
      if (r.stdout) proc.stdout.write(r.stdout);
      if (r.stderr) proc.stderr.write(r.stderr);
      const code = r.exitCode ?? 0;
      if (proc.exit) proc.exit(code);
      return code;
    }
    // No piped input and no args - show help
    proc.stderr.write('c: no input provided. Use -h for help.\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }

  let code: string;
  let displayName = '<string>';
  if (inlineCode !== null) {
    code = inlineCode;
    displayName = '<-c>';
  } else if (readStdin) {
    code = readStdinAll();
    displayName = '<stdin>';
  } else {
    // scriptPath !== null
    const fs = getFs();
    if (!fs) {
      proc.stderr.write('c: __fs unavailable\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
    try {
      code = fs.readFile(scriptPath!);
    } catch (e) {
      proc.stderr.write("c: can't open file '" + scriptPath + "': " + (e instanceof Error ? e.message : String(e)) + '\n');
      if (proc.exit) proc.exit(2);
      return 2;
    }
    displayName = scriptPath!;
  }

  const argvForC = [displayName, ...scriptArgs];
  try {
    const r = call('c.exec', {
      code,
      argv: argvForC,
    }) as { stdout: string; stderr: string; exitCode: number };
    if (r.stdout) proc.stdout.write(r.stdout);
    if (r.stderr) proc.stderr.write(r.stderr);
    const exitCode = r.exitCode ?? 0;
    if (proc.exit) proc.exit(exitCode);
    return exitCode;
  } catch (e) {
    proc.stderr.write('c: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }
};
