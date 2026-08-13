// dsh custom commands: clang, clang++, gcc, g++, cc
//
// Routes compilation through the host-side clang.ts IPC bridge (YoWASP Clang
// WASM). Without this, just-bash finds /bin/clang as an executable file on
// PATH via TfsFs (which grants execute bits to all /bin/ paths), reads its
// JS bundle content, and attempts to parse it as bash — producing
// "Parse error near unexpected token `('".
//
// By registering these as custom commands, just-bash's CommandRegistry
// intercepts them before the external-command / script-execution path.

// @ts-nocheck
import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('clang: ipc unavailable in this context');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

const SOURCE_EXTENSIONS = new Set(['c', 'cc', 'cpp', 'cxx', 'c++', 'h', 'hpp', 'hxx', 'h++', 's', 'o', 'a']);

// Resolve a (possibly relative) path against cwd into a normalised absolute
// path. All file paths sent to the host clang.exec bridge (both as file map
// keys and as compiler arguments) must be absolute so the nested Tree
// structure built on the host side maps 1:1 onto the paths clang looks up.
const resolvePath = (cwd: string, p: string): string => {
  const full = p.startsWith('/') ? p : cwd + '/' + p;
  const parts = full.split('/').filter((s) => s && s !== '.');
  const segs: string[] = [];
  for (const part of parts) part === '..' ? segs.pop() : segs.push(part);
  return '/' + segs.join('/');
};

const makeClangCommand = (name: string): Command => ({
  name,
  trusted: true,
  async execute(argv: string[], ctx: CommandContext): Promise<ExecResult> {
    // --version / -v: print version and exit
    if (argv.includes('--version') || argv.includes('-v')) {
      try {
        const r = call('clang.version') as { version: string };
        return { stdout: r.version + '\n', stderr: '', exitCode: 0 };
      } catch (e) {
        return { stdout: '', stderr: name + ': ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
      }
    }

    const cwd: string = ctx.cwd ?? '/';
    const isCpp = name.includes('++');

    // Rewrite every file-like argument to an absolute path so it matches
    // the nested Tree structure the host builds from filesIn (see
    // src/host/clang.ts). This covers positional source/object files and
    // the path following -o; both the compiler args and the filesIn keys
    // must agree on the same absolute path for WASI's lookup to succeed.
    const resolvedArgv = argv.slice();
    const filesIn: Record<string, string | Uint8Array> = {};
    for (let i = 0; i < resolvedArgv.length; i++) {
      const arg = resolvedArgv[i]!;
      if (arg === '-o' && i + 1 < resolvedArgv.length) {
        resolvedArgv[i + 1] = resolvePath(cwd, resolvedArgv[i + 1]!);
        i++;
        continue;
      }
      if (arg.startsWith('-')) continue;
      const ext = arg.split('.').pop()?.toLowerCase() ?? '';
      if (!SOURCE_EXTENSIONS.has(ext)) continue;

      const fullPath = resolvePath(cwd, arg);
      resolvedArgv[i] = fullPath;
      try {
        filesIn[fullPath] = await ctx.fs.readFile(fullPath);
      } catch {
        // Not found or not a readable file — skip (may be an output path)
      }
    }

    // First arg is the canonical binary name; rest are the user's flags/files
    const clangArgs = [isCpp ? 'clang++' : 'clang', ...resolvedArgv];

    try {
      const r = call('clang.exec', { args: clangArgs, filesIn }) as {
        filesOut: Record<string, string | Uint8Array>;
        stdout: string;
        stderr: string;
        exitCode: number;
      };

      // Write output files back into the virtual FS. filesOut keys are
      // always absolute paths (see treeFlatten in src/host/clang.ts).
      if (r.filesOut) {
        console.log('DEBUG filesOut keys:', Object.keys(r.filesOut));
        console.log('DEBUG filesIn keys:', Object.keys(filesIn));
        for (const [filename, content] of Object.entries(r.filesOut)) {
          if (filename in filesIn) continue; // skip unchanged input files
          try {
            await ctx.fs.writeFile(filename, content);
            console.log('DEBUG wrote', filename);
          } catch (e) {
            console.log('DEBUG write failed', filename, e);
          }
        }
      }

      return {
        stdout: r.stdout ?? '',
        stderr: r.stderr ?? '',
        exitCode: r.exitCode ?? 0,
      };
    } catch (e) {
      return { stdout: '', stderr: name + ': ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
    }
  },
});

export const clangCommand   = makeClangCommand('clang');
export const clangppCommand = makeClangCommand('clang++');
export const gccCommand     = makeClangCommand('gcc');
export const gppCommand     = makeClangCommand('g++');
export const ccCommand      = makeClangCommand('cc');
