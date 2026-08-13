// /bin/clang, /bin/clang++, /bin/gcc, /bin/g++, /bin/cc — C/C++ compiler via YoWASP Clang
//
// Usage:
//   clang hello.c -o hello              compile and link
//   clang -c hello.c -o hello.o         compile only
//   clang++ hello.cpp -o hello          C++ mode
//   gcc hello.c -o hello                GCC compatibility alias
//   clang --version
//
// Heavy lifting (Clang/LLVM WASM) is done on the host; see src/host/clang.ts.
// TFS integration: source files are read from TFS and passed to Clang's virtual FS.
// Output files (object files, executables) are written back to TFS.

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
  writeFile: (p: string, d: string | Uint8Array) => void;
  exists: (p: string) => boolean;
  readdir: (p: string) => string[];
};
const getFs = (): FsGlobal | undefined => (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;

export const main = async (): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;

  const fs = getFs();
  if (!fs) {
    proc.stderr.write('clang: __fs unavailable\n');
    return 1;
  }

  const argv = proc.argv.slice(1);
  
  // Determine compiler mode based on binary name (clang vs clang++ vs gcc vs g++)
  const binaryName = proc.argv[0]?.split('/').pop() || 'clang';
  const isCpp = binaryName.includes('++') || binaryName.startsWith('g++');

  // Handle --version separately for cleaner output
  if (argv.includes('--version') || argv.includes('-v')) {
    try {
      const r = call('clang.version') as { version: string };
      proc.stdout.write(r.version + '\n');
      return 0;
    } catch (e) {
      proc.stderr.write('clang: ' + (e instanceof Error ? e.message : String(e)) + '\n');
      return 1;
    }
  }

  const cwd = proc.cwd();

  // Resolve a (possibly relative) path against cwd into a normalised
  // absolute path. All file paths sent to the host clang.exec bridge (both
  // as file map keys and as compiler arguments) must be absolute so the
  // nested Tree structure built on the host side maps 1:1 onto the paths
  // clang looks up (see treeSet/treeFlatten in src/host/clang.ts).
  const resolvePath = (p: string): string => {
    const full = p.startsWith('/') ? p : cwd + '/' + p;
    const parts = full.split('/').filter((s) => s && s !== '.');
    const segs: string[] = [];
    for (const part of parts) part === '..' ? segs.pop() : segs.push(part);
    return '/' + segs.join('/');
  };

  // Rewrite every file-like argument (positional source files, and the
  // path following -o) to an absolute path, and collect source file
  // contents from TFS keyed by that same absolute path.
  const filesIn: Record<string, string | Uint8Array> = {};
  const resolvedArgv = argv.slice();
  for (let i = 0; i < resolvedArgv.length; i++) {
    const arg = resolvedArgv[i]!;
    if (arg === '-o' && i + 1 < resolvedArgv.length) {
      resolvedArgv[i + 1] = resolvePath(resolvedArgv[i + 1]!);
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;

    const ext = arg.split('.').pop()?.toLowerCase();
    if (!ext) continue;
    const isSourceFile = ['c', 'cc', 'cpp', 'cxx', 'c++', 'h', 'hpp', 'hxx', 'h++', 's', 'S', 'o', 'a'].includes(ext);
    if (!isSourceFile) continue;

    const fullPath = resolvePath(arg);
    resolvedArgv[i] = fullPath;
    try {
      if (fs.exists(fullPath)) {
        filesIn[fullPath] = fs.readFile(fullPath);
      }
    } catch (e) {
      // File might not exist yet (e.g., output file), skip
    }
  }

  // Build the arguments for clang. YoWASP clang expects the first arg to
  // be the binary name.
  const clangArgs = [isCpp ? 'clang++' : 'clang', ...resolvedArgv];

  // Execute clang
  try {
    const r = call('clang.exec', {
      args: clangArgs,
      filesIn,
    }) as {
      filesOut: Record<string, string | Uint8Array>;
      stdout: string;
      stderr: string;
      exitCode: number;
    };

    // Write stdout/stderr
    if (r.stdout) proc.stdout.write(r.stdout);
    if (r.stderr) proc.stderr.write(r.stderr);

    // Write output files back to TFS. filesOut keys are always absolute
    // paths (see treeFlatten in src/host/clang.ts).
    if (r.filesOut) {
      for (const [filename, content] of Object.entries(r.filesOut)) {
        // Skip input files (they're in filesOut too)
        if (filename in filesIn) continue;

        try {
          fs.writeFile(filename, content);
        } catch (e) {
          proc.stderr.write('clang: failed to write ' + filename + ': ' + (e instanceof Error ? e.message : String(e)) + '\n');
        }
      }
    }

    const exitCode = r.exitCode ?? 0;
    if (proc.exit) proc.exit(exitCode);
    return exitCode;
  } catch (e) {
    proc.stderr.write('clang: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }
};
