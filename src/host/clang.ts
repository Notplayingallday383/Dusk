// Host-side Clang/LLVM bridge for /bin/c and /bin/c++
//
// This integrates YoWASP Clang (real LLVM/Clang 22.1.0 compiled to WASM)
// to provide a production-grade C/C++ compiler in the browser.
//
// Pipeline:
//   1. Compile C/C++ source → WASM binary using YoWASP Clang
//   2. Execute the WASM binary using a minimal browser WASI shim
//   3. Return stdout/stderr/exitCode to the caller
//
// Size: ~100MB WASM, downloaded once on first use and cached.
// Performance: Compiles in ~100-500ms, runs in <10ms for typical programs.

import type { FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';

const ok = (send: (m: unknown) => void, value: unknown): void => { send({ value }); };
const err = (send: (m: unknown) => void, e: unknown): void => {
  send({ error: e instanceof Error ? e.message : String(e) });
};

// YoWASP Tree type: virtual filesystem nodes
type Tree = {
  [name: string]: Tree | string | Uint8Array;
};

type RunOptions = {
  stdin?: ((byteLength: number) => Uint8Array | null) | null;
  stdout?: ((bytes: Uint8Array | null) => void) | null;
  stderr?: ((bytes: Uint8Array | null) => void) | null;
  decodeASCII?: boolean;
  fetchProgress?: (event: { source: object; totalLength: number; doneLength: number }) => void;
};

type Command = (args?: string[], files?: Tree, options?: RunOptions) => Promise<Tree> | Tree | undefined;

interface ClangCommands {
  clang: Command;
  'clang++': Command;
}

// Lazy load — Vite code-splits the ~100MB WASM automatically
let clangPromise: Promise<ClangCommands> | undefined;

const loadClang = async (): Promise<ClangCommands> => {
  if (!clangPromise) {
    clangPromise = (async (): Promise<ClangCommands> => {
      const mod = await import('@yowasp/clang');
      return { clang: mod.commands.clang, 'clang++': mod.commands['clang++'] };
    })();
  }
  return clangPromise;
};

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// ---------------------------------------------------------------------------
// Minimal browser WASI shim
//
// The compiled WASM is a WASI preview1 binary.  We only need a subset of the
// WASI surface to run simple C/C++ programs: fd_write (stdout/stderr),
// proc_exit, args_get/args_sizes_get, environ_get/environ_sizes_get, and a
// handful of stubs for the rest.  Complex syscalls (open, read, seek) are
// stubbed out — they return ENOSYS so libc still links but file I/O beyond
// stdin/stdout/stderr won't work for now.
// ---------------------------------------------------------------------------

const WASI_ERRNO_SUCCESS = 0;
const WASI_ERRNO_NOSYS = 52;
const WASI_ERRNO_BADF = 8;

class WasiExitError extends Error {
  constructor(public readonly code: number) { super(`exit(${code})`); }
}

function buildWasiImports(
  args: string[],
  stdoutChunks: Uint8Array[],
  stderrChunks: Uint8Array[],
  stdinData: Uint8Array,
  memRef: { current: WebAssembly.Memory | null },
): WebAssembly.ModuleImports {
  let stdinPos = 0;

  const mem = (): DataView => {
    if (!memRef.current) throw new Error('WASI: memory not yet set');
    return new DataView(memRef.current.buffer);
  };

  // Encode args as null-terminated strings
  const argBufs = args.map(a => encoder.encode(a + '\0'));

  return {
    args_sizes_get(argc_ptr: number, argv_buf_size_ptr: number): number {
      const dv = mem();
      dv.setUint32(argc_ptr, argBufs.length, true);
      dv.setUint32(argv_buf_size_ptr, argBufs.reduce((s, b) => s + b.length, 0), true);
      return WASI_ERRNO_SUCCESS;
    },
    args_get(argv_ptr: number, argv_buf_ptr: number): number {
      const dv = mem();
      let bufOff = argv_buf_ptr;
      for (let i = 0; i < argBufs.length; i++) {
        dv.setUint32(argv_ptr + i * 4, bufOff, true);
        new Uint8Array(memRef.current!.buffer).set(argBufs[i]!, bufOff);
        bufOff += argBufs[i]!.length;
      }
      return WASI_ERRNO_SUCCESS;
    },
    environ_sizes_get(count_ptr: number, size_ptr: number): number {
      const dv = mem();
      dv.setUint32(count_ptr, 0, true);
      dv.setUint32(size_ptr, 0, true);
      return WASI_ERRNO_SUCCESS;
    },
    environ_get(_environ_ptr: number, _environ_buf_ptr: number): number {
      return WASI_ERRNO_SUCCESS;
    },
    fd_write(fd: number, iovs_ptr: number, iovs_len: number, nwritten_ptr: number): number {
      const dv = mem();
      const raw = new Uint8Array(memRef.current!.buffer);
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const base = dv.getUint32(iovs_ptr + i * 8, true);
        const len  = dv.getUint32(iovs_ptr + i * 8 + 4, true);
        const chunk = raw.slice(base, base + len);
        if (fd === 1) stdoutChunks.push(chunk);
        else if (fd === 2) stderrChunks.push(chunk);
        else return WASI_ERRNO_BADF;
        total += len;
      }
      dv.setUint32(nwritten_ptr, total, true);
      return WASI_ERRNO_SUCCESS;
    },
    fd_read(fd: number, iovs_ptr: number, iovs_len: number, nread_ptr: number): number {
      if (fd !== 0) return WASI_ERRNO_BADF;
      const dv = mem();
      const raw = new Uint8Array(memRef.current!.buffer);
      let total = 0;
      for (let i = 0; i < iovs_len; i++) {
        const base = dv.getUint32(iovs_ptr + i * 8, true);
        const len  = dv.getUint32(iovs_ptr + i * 8 + 4, true);
        const avail = Math.min(len, stdinData.length - stdinPos);
        if (avail > 0) {
          raw.set(stdinData.subarray(stdinPos, stdinPos + avail), base);
          stdinPos += avail;
          total += avail;
        }
      }
      dv.setUint32(nread_ptr, total, true);
      return WASI_ERRNO_SUCCESS;
    },
    fd_close(_fd: number): number { return WASI_ERRNO_SUCCESS; },
    fd_seek(_fd: number, _offset_lo: number, _offset_hi: number, _whence: number, _newoffset_ptr: number): number {
      return WASI_ERRNO_NOSYS;
    },
    fd_fdstat_get(fd: number, stat_ptr: number): number {
      if (fd > 2) return WASI_ERRNO_BADF;
      const dv = mem();
      // filetype = 2 (character_device for stdio), flags = 0, rights = all ones
      dv.setUint8(stat_ptr, 2);
      dv.setUint8(stat_ptr + 1, 0);
      dv.setUint16(stat_ptr + 2, 0, true);
      dv.setBigUint64(stat_ptr + 8, 0xffffffffffffffffn, true);
      dv.setBigUint64(stat_ptr + 16, 0xffffffffffffffffn, true);
      return WASI_ERRNO_SUCCESS;
    },
    fd_prestat_get(_fd: number, _buf_ptr: number): number { return WASI_ERRNO_BADF; },
    fd_prestat_dir_name(_fd: number, _path_ptr: number, _path_len: number): number { return WASI_ERRNO_BADF; },
    path_open(): number { return WASI_ERRNO_NOSYS; },
    path_filestat_get(): number { return WASI_ERRNO_NOSYS; },
    path_create_directory(): number { return WASI_ERRNO_NOSYS; },
    path_remove_directory(): number { return WASI_ERRNO_NOSYS; },
    path_unlink_file(): number { return WASI_ERRNO_NOSYS; },
    path_rename(): number { return WASI_ERRNO_NOSYS; },
    path_readlink(): number { return WASI_ERRNO_NOSYS; },
    path_symlink(): number { return WASI_ERRNO_NOSYS; },
    fd_readdir(): number { return WASI_ERRNO_NOSYS; },
    fd_sync(): number { return WASI_ERRNO_SUCCESS; },
    fd_advise(): number { return WASI_ERRNO_SUCCESS; },
    fd_allocate(): number { return WASI_ERRNO_NOSYS; },
    clock_time_get(_id: number, _precision_lo: number, _precision_hi: number, time_ptr: number): number {
      const now = BigInt(Date.now()) * 1_000_000n;
      mem().setBigUint64(time_ptr, now, true);
      return WASI_ERRNO_SUCCESS;
    },
    clock_res_get(_id: number, res_ptr: number): number {
      mem().setBigUint64(res_ptr, 1_000_000n, true);
      return WASI_ERRNO_SUCCESS;
    },
    random_get(buf_ptr: number, buf_len: number): number {
      const raw = new Uint8Array(memRef.current!.buffer);
      crypto.getRandomValues(raw.subarray(buf_ptr, buf_ptr + buf_len));
      return WASI_ERRNO_SUCCESS;
    },
    sched_yield(): number { return WASI_ERRNO_SUCCESS; },
    poll_oneoff(): number { return WASI_ERRNO_NOSYS; },
    proc_exit(code: number): never { throw new WasiExitError(code); },
    proc_raise(_sig: number): number { throw new WasiExitError(128); },
    sock_accept(): number { return WASI_ERRNO_NOSYS; },
    sock_recv(): number { return WASI_ERRNO_NOSYS; },
    sock_send(): number { return WASI_ERRNO_NOSYS; },
    sock_shutdown(): number { return WASI_ERRNO_NOSYS; },
  };
}

async function runWasmBinary(
  wasmBytes: Uint8Array,
  programArgs: string[],
  stdinText: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const stdinData = encoder.encode(stdinText);
  const memRef: { current: WebAssembly.Memory | null } = { current: null };

  const wasiImports = buildWasiImports(programArgs, stdoutChunks, stderrChunks, stdinData, memRef);
  const importObject: WebAssembly.Imports = {
    wasi_snapshot_preview1: wasiImports,
    // Some WASM binaries also import under "wasi_unstable"
    wasi_unstable: wasiImports,
  };

  let exitCode = 0;
  try {
    // Copy into a plain ArrayBuffer to satisfy TS (avoids SharedArrayBuffer widening)
    const plainBuf = wasmBytes.buffer.slice(wasmBytes.byteOffset, wasmBytes.byteOffset + wasmBytes.byteLength) as ArrayBuffer;
    const compiled = await WebAssembly.compile(plainBuf);
    const instance = await WebAssembly.instantiate(compiled, importObject);

    // Grab exported memory (required by WASI)
    if (instance.exports['memory'] instanceof WebAssembly.Memory) {
      memRef.current = instance.exports['memory'] as WebAssembly.Memory;
    }

    // Entry point is _start (WASI command module)
    const start = instance.exports['_start'] as (() => void) | undefined;
    if (!start) throw new Error('WASM binary has no _start export');
    start();
  } catch (e) {
    if (e instanceof WasiExitError) {
      exitCode = e.code;
    } else {
      // Unexpected trap — surface as stderr
      const msg = e instanceof Error ? e.message : String(e);
      stderrChunks.push(encoder.encode('runtime error: ' + msg + '\n'));
      exitCode = 1;
    }
  }

  const concat = (chunks: Uint8Array[]): string => {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return decoder.decode(out);
  };

  return { stdout: concat(stdoutChunks), stderr: concat(stderrChunks), exitCode };
}

// ---------------------------------------------------------------------------
// Compile C/C++ using YoWASP and run it.
// ---------------------------------------------------------------------------

async function compileAndRun(
  code: string,
  filename: string,
  stdinText: string,
  isCpp: boolean,
  extraCompilerArgs: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const clang = await loadClang();
  const compiler = isCpp ? clang['clang++'] : clang.clang;

  let compileStderr = '';
  const filesIn: Tree = { [filename]: code };
  const compilerArgs = [isCpp ? 'clang++' : 'clang', filename, '-o', 'program.wasm', ...extraCompilerArgs];

  let filesOut: Tree | undefined;
  try {
    filesOut = await compiler(compilerArgs, filesIn, {
      stderr: (bytes) => { if (bytes) compileStderr += decoder.decode(bytes); },
      fetchProgress: ({ totalLength, doneLength }) => {
        const pct = totalLength > 0 ? Math.floor((doneLength / totalLength) * 100) : 0;
        if (pct % 10 === 0 && doneLength < totalLength) {
          console.log(`[clang] Downloading: ${pct}%`);
        }
      },
    }) as Tree | undefined;
  } catch (e) {
    // YoWASP throws Exit on non-zero exit code
    if (e && typeof e === 'object' && 'code' in e) {
      const exitErr = e as { code: number; files?: Tree };
      // stderr may have been captured via callback above; also try files
      if (!compileStderr && exitErr.files) {
        const stderrFile = (exitErr.files as Record<string, unknown>)['stderr'];
        if (typeof stderrFile === 'string') compileStderr = stderrFile;
        else if (stderrFile instanceof Uint8Array) compileStderr = decoder.decode(stderrFile);
      }
      if (!compileStderr) compileStderr = `Compilation failed (exit ${exitErr.code})`;
      return { stdout: '', stderr: compileStderr, exitCode: exitErr.code };
    }
    throw e;
  }

  const wasmFile = filesOut?.['program.wasm'];
  if (!(wasmFile instanceof Uint8Array)) {
    // Compilation "succeeded" but no WASM output — unusual; treat as error
    const detail = compileStderr || 'No output produced by compiler';
    return { stdout: '', stderr: detail, exitCode: 1 };
  }

  // Run the compiled WASM with our WASI shim
  const runResult = await runWasmBinary(wasmFile, [filename], stdinText);

  // Merge compile-time warnings with runtime stderr
  return {
    stdout: runResult.stdout,
    stderr: compileStderr + runResult.stderr,
    exitCode: runResult.exitCode,
  };
}

// ---------------------------------------------------------------------------
// IPC function table
// ---------------------------------------------------------------------------

export const createClangFuncs = (fs: FSBackend): FuncTable => ({
  // clang.compile { code, filename?, stdin?, args? }
  //   Compiles and runs a C or C++ program, returning stdout/stderr/exitCode.
  'clang.compile': async (m, send): Promise<void> => {
    try {
      const code     = m['code'] as string;
      const filename = (m['filename'] as string | undefined) ?? 'program.c';
      const stdinTxt = (m['stdin']    as string | undefined) ?? '';
      const extraArgs = (m['args']   as string[] | undefined) ?? [];
      const isCpp = filename.endsWith('.cpp') || filename.endsWith('.cxx') || filename.endsWith('.cc');

      const result = await compileAndRun(code, filename, stdinTxt, isCpp, extraArgs);
      ok(send, result);
    } catch (e) {
      err(send, e);
    }
  },

  // clang.version → { version: string }
  'clang.version': async (_m, send): Promise<void> => {
    try {
      const clang = await loadClang();
      let versionOutput = '';
      await clang.clang(['clang', '--version'], {}, {
        stdout: (bytes) => { if (bytes) versionOutput += decoder.decode(bytes); },
      });
      ok(send, { version: versionOutput.trim() });
    } catch (e) {
      // YoWASP throws Exit even for --version (exit 0); files has output
      if (e && typeof e === 'object' && 'code' in e && (e as { code: number }).code === 0) {
        const exitErr = e as { code: number; files?: Tree };
        let ver = '';
        if (exitErr.files) {
          const out = (exitErr.files as Record<string, unknown>)['stdout'];
          if (typeof out === 'string') ver = out;
          else if (out instanceof Uint8Array) ver = decoder.decode(out);
        }
        ok(send, { version: ver.trim() || 'clang (YoWASP)' });
      } else {
        err(send, e);
      }
    }
  },

  // Marker so TS uses `fs` (reserved for future TFS file I/O)
  __clang_touch_fs: ((_m: Record<string, unknown>, send: (m: unknown) => void): void => {
    void fs; ok(send, { ok: true });
  }) as unknown as FuncTable[string],
});
