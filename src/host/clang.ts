// Host-side Clang bridge for /bin/clang and /bin/clang++ (and /bin/gcc, /bin/g++ aliases).
//
// Uses YoWASP Clang (LLVM toolchain compiled to WASM) loaded lazily on first use.
// YoWASP Clang provides both the compiler and linker (lld) in one package.
//
// TFS integration: source files are pushed to Clang's virtual FS before
// compilation, and outputs (object files, executables) are pulled back after.

import type { FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';

type Tree = {
  [name: string]: Tree | string | Uint8Array;
};

type InputStream = (byteLength: number) => Uint8Array | null;
type OutputStream = (bytes: Uint8Array | null) => void;

type RunOptions = {
  stdin?: InputStream | null;
  stdout?: OutputStream | null;
  stderr?: OutputStream | null;
  decodeASCII?: boolean;
  synchronously?: boolean;
};

type Command = (args?: string[], files?: Tree, options?: RunOptions) => Promise<Tree> | Tree | undefined;

type ClangModule = {
  commands: {
    'clang': Command;
    'clang++': Command;
  };
};

// YoWASP's Tree type is a *nested* directory structure (one level of object
// per path component), not a flat map keyed by full path strings. WASI
// resolves absolute paths (e.g. "/tmp/hello.c") by walking the preopened
// root directory component-by-component, so a flat key like "/tmp/hello.c"
// (with literal slashes embedded in one map key) never matches — clang
// reports "no such file or directory" even though the content was supplied.
//
// These helpers convert between the flat `{ "/abs/path": content }` maps
// used elsewhere in DuskJS (TFS, IPC payloads) and YoWASP's nested Tree.
const treeSet = (tree: Tree, path: string, content: string | Uint8Array): void => {
  const segs = path.split('/').filter((s) => s.length > 0);
  if (segs.length === 0) return;
  let cur: Tree = tree;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]!;
    const existing = cur[seg];
    if (existing && typeof existing === 'object' && !(existing instanceof Uint8Array)) {
      cur = existing;
    } else {
      const created: Tree = {};
      cur[seg] = created;
      cur = created;
    }
  }
  cur[segs[segs.length - 1]!] = content;
};

const treeFlatten = (tree: Tree, prefix = ''): Record<string, string | Uint8Array> => {
  const out: Record<string, string | Uint8Array> = {};
  for (const [name, value] of Object.entries(tree)) {
    const full = prefix + '/' + name;
    if (typeof value === 'string' || value instanceof Uint8Array) {
      out[full] = value;
    } else if (value && typeof value === 'object') {
      Object.assign(out, treeFlatten(value, full));
    }
  }
  return out;
};

let clangPromise: Promise<ClangModule> | undefined;

const loadClang = async (): Promise<ClangModule> => {
  if (!clangPromise) {
    clangPromise = (async (): Promise<ClangModule> => {
      // Import the YoWASP clang package
      const mod = await import('@yowasp/clang') as ClangModule;
      return mod;
    })();
  }
  return clangPromise;
};

const ok = (send: (m: unknown) => void, value: unknown): void => { send({ value }); };
const err = (send: (m: unknown) => void, e: unknown): void => {
  send({ error: e instanceof Error ? e.message : String(e) });
};

export const createClangFuncs = (fs: FSBackend): FuncTable => ({
  // clang.exec { args: string[], filesIn: Record<string, string | Uint8Array> }
  //   → { filesOut: Record<string, string | Uint8Array>, stdout: string, stderr: string, exitCode: number }
  // Runs clang with the given arguments and input files.
  // Returns output files, stdout, stderr, and exit code.
  'clang.exec': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const clangMod = await loadClang();
        const args = (m['args'] as string[] | undefined) ?? [];
        // filesIn arrives as a flat map of absolute (or bare-filename)
        // paths → content; convert to the nested Tree YoWASP expects.
        const filesInFlat = (m['filesIn'] as Record<string, string | Uint8Array> | undefined) ?? {};
        const filesIn: Tree = {};
        for (const [p, content] of Object.entries(filesInFlat)) treeSet(filesIn, p, content);

        // Buffer stdout/stderr for this execution
        let stdoutBuf = '';
        let stderrBuf = '';
        
        const stdoutHandler = (bytes: Uint8Array | null): void => {
          if (bytes === null) return; // flush
          stdoutBuf += new TextDecoder().decode(bytes);
        };
        
        const stderrHandler = (bytes: Uint8Array | null): void => {
          if (bytes === null) return; // flush
          stderrBuf += new TextDecoder().decode(bytes);
        };

        let exitCode = 0;
        let filesOut: Tree = {};
        
        // Determine which command to use based on first arg
        const isCpp = args[0] === 'clang++';
        const command = isCpp ? clangMod.commands['clang++'] : clangMod.commands['clang'];
        
        // Remove the command name from args (YoWASP doesn't expect it)
        const clangArgs = args.slice(1);
        
        try {
          const result = await command(clangArgs, filesIn, {
            stdout: stdoutHandler,
            stderr: stderrHandler,
          });
          if (result) filesOut = result;
        } catch (e) {
          // YoWASP throws an Exit exception on non-zero exit codes
          if (e && typeof e === 'object' && 'code' in e && 'files' in e) {
            exitCode = (e as { code: number; files: Tree }).code;
            filesOut = (e as { code: number; files: Tree }).files;
          } else {
            throw e;
          }
        }
        
        // Flatten the nested output Tree back into a flat map of absolute
        // paths for the caller (dsh command / /bin/clang) to write into TFS.
        const flatFilesOut = treeFlatten(filesOut);
        ok(send, { filesOut: flatFilesOut, stdout: stdoutBuf, stderr: stderrBuf, exitCode });
      } catch (e) { err(send, e); }
    })();
  },

  // clang.version → { version: string }
  'clang.version': (_m, send): void => {
    void (async (): Promise<void> => {
      try {
        const clangMod = await loadClang();
        let versionStr = '';
        await clangMod.commands.clang(['--version'], {}, {
          stdout: (bytes: Uint8Array | null): void => {
            if (bytes) versionStr += new TextDecoder().decode(bytes);
          },
        });
        ok(send, { version: versionStr.trim() });
      } catch (e) { err(send, e); }
    })();
  },

  // Marker so TS uses `fs` (a hook for future TFS↔Clang auto-sync).
  __clang_touch_fs: ((_m: Record<string, unknown>, send: (m: unknown) => void): void => {
    void fs; ok(send, { ok: true });
  }) as unknown as FuncTable[string],
});
