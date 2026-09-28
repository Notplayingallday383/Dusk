import { Readable, Writable } from './node-stream';
import { errnoError } from './node-errors';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    // Error string may be a bare message ("EBADF: ...") or a stack ("Error: EBADF: ...\n at ...").
    const m = /(?:^|Error:\s*)([A-Z]{2,}[A-Z_0-9]*):/.exec(r.error);
    const code = m && m[1] ? m[1] : 'UNKNOWN';
    const syscall = f.replace('fs.', '');
    const path = typeof extra['path'] === 'string' ? extra['path'] as string : undefined;
    throw errnoError(code, syscall, path, r.error);
  }
  return r.value;
};

type Cb = (err: Error | null, result?: unknown) => void;

const defer = (fn: () => void): void => { void Promise.resolve().then(fn); };

const cbOp = (run: () => unknown, cb?: Cb): void => {
  defer(() => {
    try { const r = run(); cb?.(null, r); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const promiseOp = <T>(run: () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    defer(() => {
      try { resolve(run()); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  });

const toBuffer = (data: unknown): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(s: string | Uint8Array | number[], enc?: string): Uint8Array };
  if (Buffer) {
    if (typeof data === 'string') return Buffer.from(data, 'utf8');
    if (data instanceof Uint8Array) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.from(data as number[]);
  }
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(0);
};

const bytesToString = (b: Uint8Array, encoding?: string): string => {
  if (!encoding) {
    // Return Buffer-like for callers that didn't ask for an encoding.
    const g = globalThis as Record<string, unknown>;
    const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): Uint8Array & { toString(enc: string): string } };
    if (Buffer) return Buffer.from(b) as unknown as string;
    return b as unknown as string;
  }
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(enc: string): string } };
  if (Buffer) return Buffer.from(b).toString(encoding);
  // Fallback: utf8 only
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

const invalidPath = (): never => {
  const error = new TypeError('The "path" argument must be of type string or an instance of URL');
  (error as Error & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
  throw error;
};

const normalizePath = (path: unknown): string => {
  if (typeof path === 'string') return path;
  if (!path || typeof path !== 'object') return invalidPath();
  const url = path as { protocol?: unknown; hostname?: unknown; pathname?: unknown };
  if (url.protocol !== 'file:') {
    const error = new TypeError('The URL must be of scheme file:');
    (error as Error & { code?: string }).code = 'ERR_INVALID_URL_SCHEME';
    throw error;
  }
  if (url.hostname !== '') {
    const error = new TypeError('File URL host must be empty or localhost');
    (error as Error & { code?: string }).code = 'ERR_INVALID_FILE_URL_HOST';
    throw error;
  }
  if (typeof url.pathname !== 'string') return invalidPath();
  if (/%2f|%5c/i.test(url.pathname)) {
    const error = new TypeError('File URL path must not include encoded slash characters');
    (error as Error & { code?: string }).code = 'ERR_INVALID_FILE_URL_PATH';
    throw error;
  }
  return decodeURIComponent(url.pathname);
};

// ---- Stats ----

interface RawStat {
  isFile: boolean;
  isDirectory: boolean;
  size?: number;
  mtimeMs?: number;
  atimeMs?: number;
  ctimeMs?: number;
  birthtimeMs?: number;
  mode?: number;
}

class Stats {
  size: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
  mtimeKnown: boolean;
  mode: number;
  uid = 1000;
  gid = 1000;
  ino = 0;
  dev = 0;
  nlink = 1;
  rdev = 0;
  blksize = 4096;
  blocks = 0;

  private _isFile: boolean;
  private _isDirectory: boolean;

  constructor(raw: RawStat) {
    this._isFile = raw.isFile;
    this._isDirectory = raw.isDirectory;
    this.size = raw.size ?? 0;
    this.mtimeMs = raw.mtimeMs ?? 0;
    this.mtimeKnown = raw.mtimeMs !== undefined;
    this.atimeMs = raw.atimeMs ?? 0;
    this.ctimeMs = raw.ctimeMs ?? 0;
    this.birthtimeMs = raw.birthtimeMs ?? 0;
    this.mode = raw.mode ?? (raw.isDirectory ? 0o40755 : 0o100644);
    this.blocks = Math.ceil(this.size / 512);
  }

  isFile(): boolean { return this._isFile; }
  isDirectory(): boolean { return this._isDirectory; }
  isSymbolicLink(): boolean { return false; }
  isBlockDevice(): boolean { return false; }
  isCharacterDevice(): boolean { return false; }
  isFIFO(): boolean { return false; }
  isSocket(): boolean { return false; }

  get mtime(): Date { return new Date(this.mtimeMs); }
  get atime(): Date { return new Date(this.atimeMs); }
  get ctime(): Date { return new Date(this.ctimeMs); }
  get birthtime(): Date { return new Date(this.birthtimeMs); }
}

const wrapStat = (raw: RawStat): Stats => new Stats(raw);

// ---- fd ops (forward to host fd table) ----
//
// The host owns the per-pid fd table (see host/process-manager.ts fs.open/read/
// write/close/fstat/ftruncate/fsync funcs). Engine just forwards.

const _openSync = (path: string, flags: string | number, mode?: number): number => {
  return call('fs.open', { path: normalizePath(path), flags, mode }) as number;
};

const _closeSync = (fd: number): void => {
  call('fs.close', { fd });
};

const _readSync = (fd: number, buffer: Uint8Array, offset: number, length: number, position: number | null): number => {
  const res = call('fs.read', { fd, length, position }) as { bytes: number[]; bytesRead: number };
  const src = res.bytes;
  for (let i = 0; i < res.bytesRead; i++) buffer[offset + i] = src[i]!;
  return res.bytesRead;
};

const _writeSync = (fd: number, buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): number => {
  let bytes: Uint8Array;
  if (typeof buffer === 'string') {
    bytes = toBuffer(buffer);
  } else {
    const off = offset ?? 0;
    const len = length ?? buffer.length - off;
    bytes = buffer.subarray(off, off + len);
  }
  return call('fs.write', { fd, data: Array.from(bytes), position: position ?? null }) as number;
};

const _fsyncSync = (fd: number): void => {
  call('fs.fsync', { fd });
};

const _ftruncateSync = (fd: number, len = 0): void => {
  call('fs.ftruncate', { fd, length: len });
};

const _fstatSync = (fd: number): Stats => {
  return wrapStat(call('fs.fstat', { fd }) as RawStat);
};

// ---- sync API ----

const readFileSync = (path: string, optsOrEnc?: string | { encoding?: string }): unknown => {
  const data = call('fs.readFile', { path: normalizePath(path) }) as string;
  const encoding = typeof optsOrEnc === 'string' ? optsOrEnc : optsOrEnc?.encoding;
  if (encoding) return data; // already string; FS backend returns utf8
  return toBuffer(data);
};

const writeFileSync = (path: string, data: unknown, _opts?: unknown): void => {
  const text = typeof data === 'string' ? data : bytesToString(toBuffer(data), 'utf8');
  call('fs.writeFile', { path: normalizePath(path), data: text });
};

const appendFileSync = (path: string, data: unknown, _opts?: unknown): void => {
  const filePath = normalizePath(path);
  let existing = '';
  try { existing = call('fs.readFile', { path: filePath }) as string; } catch { /* */ }
  const text = typeof data === 'string' ? data : bytesToString(toBuffer(data), 'utf8');
  call('fs.writeFile', { path: filePath, data: existing + text });
};

interface Dirent {
  name: string;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

const readdirSync = (path: string, opts?: { withFileTypes?: boolean }): string[] | Dirent[] => {
  const names = call('fs.readdir', { path: normalizePath(path) }) as string[];
  if (!opts?.withFileTypes) return names;
  const base = normalizePath(path);
  return names.map((name) => {
    const stat = lstatSync(base === '/' ? '/' + name : base + '/' + name);
    return {
      name,
      isFile: () => stat.isFile(),
      isDirectory: () => stat.isDirectory(),
      isSymbolicLink: () => stat.isSymbolicLink(),
    };
  });
};

const mkdirSync = (path: string, opts?: { recursive?: boolean } | number): void => {
  const recursive = typeof opts === 'object' && opts ? opts.recursive : false;
  call('fs.mkdir', { path: normalizePath(path), recursive: Boolean(recursive) });
};

const rmSync = (path: string, opts?: { recursive?: boolean; force?: boolean }): void => {
  try { call('fs.rm', { path: normalizePath(path), recursive: Boolean(opts?.recursive) }); }
  catch (e) { if (!opts?.force) throw e; }
};

const rmdirSync = (path: string, opts?: { recursive?: boolean }): void => {
  call('fs.rm', { path: normalizePath(path), recursive: Boolean(opts?.recursive) });
};

const unlinkSync = (path: string): void => {
  call('fs.rm', { path: normalizePath(path), recursive: false });
};

const existsSync = (path: string): boolean => {
  const filePath = normalizePath(path);
  try { return call('fs.exists', { path: filePath }) === true; } catch { return false; }
};

const statSync = (path: string, _opts?: unknown): Stats => {
  return wrapStat(call('fs.stat', { path: normalizePath(path) }) as RawStat);
};

const lstatSync = (path: string): Stats => {
  try {
    return wrapStat(call('fs.lstat', { path: normalizePath(path) }) as RawStat);
  } catch {
    return wrapStat(call('fs.stat', { path: normalizePath(path) }) as RawStat);
  }
};

const symlinkSync = (target: string, path: string, _type?: string): void => {
  call('fs.symlink', { target: normalizePath(target), path: normalizePath(path) });
};

const readlinkSync = (path: string, _opts?: unknown): string => {
  return call('fs.readlink', { path: normalizePath(path) }) as string;
};

const renameSync = (from: string, to: string): void => {
  call('fs.rename', { from: normalizePath(from), to: normalizePath(to) });
};

const copyFileSync = (src: string, dest: string, _mode?: number): void => {
  const data = call('fs.readFile', { path: normalizePath(src) }) as string;
  call('fs.writeFile', { path: normalizePath(dest), data });
};

const accessSync = (path: string, _mode?: number): void => {
  const filePath = normalizePath(path);
  if (call('fs.exists', { path: filePath }) !== true) {
    throw errnoError('ENOENT', 'access', filePath);
  }
};

const realpathSync = (path: string): string => {
  const filePath = normalizePath(path);
  // No symlinks yet — return path as-is if it exists
  if (call('fs.exists', { path: filePath }) !== true) {
    throw errnoError('ENOENT', 'realpath', filePath);
  }
  return filePath;
};

const truncateSync = (path: string, len = 0): void => {
  const filePath = normalizePath(path);
  let existing = '';
  try { existing = call('fs.readFile', { path: filePath }) as string; } catch { /* */ }
  const bytes = toBuffer(existing);
  if (len < bytes.length) call('fs.writeFile', { path: filePath, data: bytesToString(bytes.subarray(0, len), 'utf8') });
  else if (len > bytes.length) {
    const expanded = new Uint8Array(len);
    expanded.set(bytes);
    call('fs.writeFile', { path: filePath, data: bytesToString(expanded, 'utf8') });
  }
};

const chmodSync = (path: string, _mode: number): void => { normalizePath(path); };
const fchmodSync = (_fd: number, _mode: number): void => { /* no-op */ };
const lchmodSync = chmodSync;
const chownSync = (path: string, _uid: number, _gid: number): void => { normalizePath(path); };
const fchownSync = (_fd: number, _uid: number, _gid: number): void => { /* no-op */ };
const lchownSync = chownSync;
const utimesSync = (path: string, _atime: Date | number, _mtime: Date | number): void => { normalizePath(path); };
const lutimesSync = utimesSync;
const futimesSync = (_fd: number, _atime: Date | number, _mtime: Date | number): void => { /* no-op */ };

// ---- async wrappers ----

const wrapSync = <T extends unknown[], R>(fn: (...args: T) => R) =>
  (...args: [...T, Cb?]): void => {
    const cb = (args[args.length - 1] as unknown) as Cb | undefined;
    if (typeof cb === 'function') {
      const realArgs = args.slice(0, -1) as unknown as T;
      defer(() => {
        try { cb(null, fn(...realArgs)); }
        catch (e) { cb(e instanceof Error ? e : new Error(String(e))); }
      });
    } else {
      // Called without callback: silent fire-and-forget
      defer(() => { try { fn(...(args as unknown as T)); } catch { /* */ } });
    }
  };

const readFile = (path: string, optsOrCb?: string | { encoding?: string } | Cb, maybeCb?: Cb): void => {
  let cb: Cb | undefined;
  let opts: string | { encoding?: string } | undefined;
  if (typeof optsOrCb === 'function') cb = optsOrCb;
  else { opts = optsOrCb; cb = maybeCb; }
  defer(() => {
    try { cb?.(null, readFileSync(path, opts)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const writeFile = (path: string, data: unknown, optsOrCb?: unknown, maybeCb?: Cb): void => {
  let cb: Cb | undefined;
  if (typeof optsOrCb === 'function') cb = optsOrCb as Cb;
  else cb = maybeCb;
  defer(() => {
    try { writeFileSync(path, data); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const appendFile = (path: string, data: unknown, optsOrCb?: unknown, maybeCb?: Cb): void => {
  let cb: Cb | undefined;
  if (typeof optsOrCb === 'function') cb = optsOrCb as Cb;
  else cb = maybeCb;
  defer(() => {
    try { appendFileSync(path, data); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const readdir = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  const opts = typeof optsOrCb === 'object' && optsOrCb ? optsOrCb as { withFileTypes?: boolean } : undefined;
  defer(() => {
    try { cb?.(null, readdirSync(path, opts as { withFileTypes?: boolean })); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const mkdir = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as { recursive?: boolean };
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { mkdirSync(path, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const rm = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as { recursive?: boolean; force?: boolean };
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { rmSync(path, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const rmdir = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb as { recursive?: boolean };
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { rmdirSync(path, opts); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const unlink = (path: string, cb?: Cb): void => {
  defer(() => {
    try { unlinkSync(path); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const stat = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, statSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const lstat = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, lstatSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const symlink = (target: string, path: string, typeOrCb?: string | Cb, maybeCb?: Cb): void => {
  const cb = (typeof typeOrCb === 'function' ? typeOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { symlinkSync(target, path); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const readlink = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, readlinkSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const rename = (from: string, to: string, cb?: Cb): void => {
  defer(() => {
    try { renameSync(from, to); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const copyFile = (src: string, dest: string, modeOrCb?: number | Cb, maybeCb?: Cb): void => {
  const cb = (typeof modeOrCb === 'function' ? modeOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { copyFileSync(src, dest); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const access = (path: string, modeOrCb?: number | Cb, maybeCb?: Cb): void => {
  const cb = (typeof modeOrCb === 'function' ? modeOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { accessSync(path); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const realpath = (path: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, realpathSync(path)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const exists = (path: string, cb?: (exists: boolean) => void): void => {
  defer(() => { try { cb?.(existsSync(path)); } catch { cb?.(false); } });
};

const open = (path: string, flagsOrCb?: string | number | Cb, modeOrCb?: number | Cb, maybeCb?: Cb): void => {
  let flags: string | number = 'r';
  let cb: Cb | undefined;
  if (typeof flagsOrCb === 'function') cb = flagsOrCb;
  else if (flagsOrCb !== undefined) flags = flagsOrCb;
  if (typeof modeOrCb === 'function') cb = modeOrCb;
  else if (maybeCb) cb = maybeCb;
  defer(() => {
    try { cb?.(null, _openSync(path, flags)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const close = (fd: number, cb?: Cb): void => {
  defer(() => {
    try { _closeSync(fd); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const read = (fd: number, bufferOrOpts: Uint8Array | { buffer: Uint8Array; offset?: number; length?: number; position?: number | null }, offsetOrCb?: number | ((err: Error | null, bytesRead: number, buf: Uint8Array) => void), lengthOrPos?: number, positionOrCb?: number | null | ((err: Error | null, bytesRead: number, buf: Uint8Array) => void), maybeCb?: (err: Error | null, bytesRead: number, buf: Uint8Array) => void): void => {
  let buffer: Uint8Array, offset = 0, length: number, position: number | null = null;
  let cb: ((err: Error | null, bytesRead: number, buf: Uint8Array) => void) | undefined;
  if (bufferOrOpts instanceof Uint8Array) {
    buffer = bufferOrOpts;
    offset = (offsetOrCb as number) ?? 0;
    length = lengthOrPos ?? buffer.length - offset;
    position = (positionOrCb as number | null) ?? null;
    cb = maybeCb;
  } else {
    buffer = bufferOrOpts.buffer;
    offset = bufferOrOpts.offset ?? 0;
    length = bufferOrOpts.length ?? buffer.length - offset;
    position = bufferOrOpts.position ?? null;
    cb = offsetOrCb as ((err: Error | null, bytesRead: number, buf: Uint8Array) => void) | undefined;
  }
  defer(() => {
    try { const n = _readSync(fd, buffer, offset, length, position); cb?.(null, n, buffer); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e)), 0, buffer); }
  });
};

const write = (fd: number, bufferOrString: Uint8Array | string, ...rest: unknown[]): void => {
  const cb = rest.find((r) => typeof r === 'function') as ((err: Error | null, written: number) => void) | undefined;
  const offset = typeof rest[0] === 'number' ? rest[0] : 0;
  const length = typeof rest[1] === 'number' ? rest[1] : undefined;
  const position = typeof rest[2] === 'number' ? rest[2] : null;
  defer(() => {
    try {
      const n = _writeSync(fd, bufferOrString, offset as number, length, position);
      cb?.(null, n);
    } catch (e) { cb?.(e instanceof Error ? e : new Error(String(e)), 0); }
  });
};

const fstat = (fd: number, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, _fstatSync(fd)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const ftruncate = (fd: number, lenOrCb?: number | Cb, maybeCb?: Cb): void => {
  const len = typeof lenOrCb === 'number' ? lenOrCb : 0;
  const cb = (typeof lenOrCb === 'function' ? lenOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { _ftruncateSync(fd, len); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const fsync = (fd: number, cb?: Cb): void => {
  defer(() => {
    try { _fsyncSync(fd); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const fdatasync = fsync;

const truncate = (path: string, lenOrCb?: number | Cb, maybeCb?: Cb): void => {
  const len = typeof lenOrCb === 'number' ? lenOrCb : 0;
  const cb = (typeof lenOrCb === 'function' ? lenOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { truncateSync(path, len); cb?.(null); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const chmod = wrapSync(chmodSync);
const fchmod = wrapSync(fchmodSync);
const lchmod = wrapSync(lchmodSync);
const chown = wrapSync(chownSync);
const fchown = wrapSync(fchownSync);
const lchown = wrapSync(lchownSync);
const utimes = wrapSync(utimesSync);
const lutimes = wrapSync(lutimesSync);
const futimes = wrapSync(futimesSync);

// ---- watch / watchFile / unwatchFile ----

type WatchListener = (event: 'rename' | 'change', filename: string | null) => void;
type HostMutation = { type: 'write' | 'mkdir' | 'rename' | 'rm'; path: string; previousPath?: string };
type DuskLifecycle = { retain(): () => void };

const lifecycle = (): DuskLifecycle | undefined =>
  ((globalThis as Record<string, unknown>)['__process'] as { __duskLifecycle?: DuskLifecycle } | undefined)?.__duskLifecycle;

interface WatchOptions {
  persistent?: boolean;
  recursive?: boolean;
  encoding?: string;
  interval?: number; // poll interval in ms (defaults to 1000, matches fs.watchFile)
}

class FSWatcher {
  private _path: string;
  private _interval: number;
  private _recursive: boolean;
  private _listeners: Map<string, Set<Function>> = new Map();
  private _closed = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _hostSubscription: number | null = null;
  private _releaseLifecycle: (() => void) | null = null;
  private _pendingHostEvents = new Map<string, 'rename' | 'change'>();
  private _hostEventsQueued = false;
  // Snapshot signatures avoid unstable synthetic stat timestamps.
  private _snapshot: Map<string, { signature: string; isDir: boolean; entries?: Set<string> }> = new Map();

  constructor(p: string, opts: WatchOptions = {}) {
    this._path = normalizePath(p);
    this._interval = opts.interval ?? 1000;
    this._recursive = !!opts.recursive;
    this._buildSnapshot(this._path);
    try {
      const id = call('fs.watch.subscribe') as number;
      if (typeof id === 'number') {
        this._hostSubscription = id;
        hostWatchers.set(id, this);
      }
    } catch { /* Older hosts use the polling fallback. */ }
    if (this._hostSubscription === null) {
      this._timer = setInterval(() => this._poll(), this._interval) as unknown as ReturnType<typeof setInterval>;
    } else {
      // Host subscriptions need no polling, but a persistent FSWatcher still
      // keeps the guest alive until close() or unref().
      this._timer = setInterval(() => {}, 0x7fffffff) as unknown as ReturnType<typeof setInterval>;
    }
    // The watcher, not its polling implementation, owns process retention.
    (this._timer as unknown as { unref?: () => void } | null)?.unref?.();
    if (opts.persistent !== false) this._retainLifecycle();
  }

  private _buildSnapshot(p: string): void {
    try {
      const st = statSync(p);
      const entry: { signature: string; isDir: boolean; entries?: Set<string> } = {
        signature: this._statSignature(p, st), isDir: st.isDirectory(),
      };
      if (entry.isDir) {
        try {
          entry.entries = new Set(readdirSync(p) as string[]);
          if (this._recursive) {
            for (const child of entry.entries) {
              this._buildSnapshot(p + '/' + child);
            }
          }
        } catch { /* */ }
      }
      this._snapshot.set(p, entry);
    } catch { /* path may not exist yet */ }
  }

  private _statSignature(path: string, st: Stats): string {
    return `${path}\0${st.mtimeKnown ? st.mtimeMs : ''}\0${st.size}\0${st.isDirectory() ? 1 : 0}`;
  }

  private _deleteSnapshotSubtree(path: string): void {
    for (const key of this._snapshot.keys()) {
      if (key === path || key.startsWith(path + '/')) this._snapshot.delete(key);
    }
  }

  private _emit(event: 'rename' | 'change' | 'close', filename: string | null): void {
    const set = this._listeners.get(event);
    if (set) {
      for (const fn of set) {
        try { (fn as Function)(event, filename); } catch { /* */ }
      }
    }
    const all = this._listeners.get('all');
    if (all) {
      for (const fn of all) {
        try { (fn as Function)(event, filename); } catch { /* */ }
      }
    }
  }

  private _poll(): void {
    if (this._closed) return;
    // Re-check the root path
    this._diffSubtree(this._path);
  }

  private _diffSubtree(p: string): void {
    let st: Stats | null = null;
    try { st = statSync(p); } catch { /* */ }
    const prev = this._snapshot.get(p);
    if (!st) {
      if (prev) {
        this._deleteSnapshotSubtree(p);
        this._emit('rename', this._relativeName(p));
      }
      return;
    }
    if (!prev) {
      this._buildSnapshot(p);
      this._emit('rename', this._relativeName(p));
      return;
    }
    // Check for changes to this entry
    const signature = this._statSignature(p, st);
    if (prev.signature !== signature) {
      prev.signature = signature;
      this._emit('change', this._relativeName(p));
    }
    // For directories, compare entry sets
    if (st.isDirectory()) {
      let current: Set<string>;
      try { current = new Set(readdirSync(p) as string[]); }
      catch { return; }
      const prevSet = prev.entries ?? new Set<string>();
      // Detect additions/removals
      for (const name of current) {
        if (!prevSet.has(name)) {
          this._emit('rename', name);
          if (this._recursive) {
            this._buildSnapshot(p + '/' + name);
          }
        }
      }
      for (const name of prevSet) {
        if (!current.has(name)) {
          this._emit('rename', name);
          this._deleteSnapshotSubtree(p + '/' + name);
        }
      }
      prev.entries = current;
      if (this._recursive) {
        for (const name of current) {
          this._diffSubtree(p + '/' + name);
        }
      }
    }
  }

  private _relativeName(p: string): string {
    if (p === this._path) return p.split('/').pop() ?? p;
    if (p.startsWith(this._path + '/')) return p.slice(this._path.length + 1);
    return p;
  }

  _onHostMutation(mutation: HostMutation): void {
    if (this._closed) return;
    const watchedPath = this._path;
    const watchesPath = (path: string | undefined): path is string => path === watchedPath
      || !!path && path.startsWith(watchedPath + '/')
        && (this._recursive || !path.slice(watchedPath.length + 1).includes('/'));
    const affectedPath = watchesPath(mutation.path)
      ? mutation.path
      : watchesPath(mutation.previousPath)
        ? mutation.previousPath
        : undefined;
    if (!affectedPath) return;
    const event = mutation.type === 'write' ? 'change' : 'rename';
    const filename = this._relativeName(affectedPath);
    const prior = this._pendingHostEvents.get(filename);
    if (prior !== 'rename') this._pendingHostEvents.set(filename, event);
    if (this._hostEventsQueued) return;
    this._hostEventsQueued = true;
    defer(() => {
      this._hostEventsQueued = false;
      if (this._closed) return;
      const events = this._pendingHostEvents;
      this._pendingHostEvents = new Map();
      for (const [name, queuedEvent] of events) this._emit(queuedEvent, name);
    });
  }

  on(event: string, listener: Function): this {
    let set = this._listeners.get(event);
    if (!set) { set = new Set(); this._listeners.set(event, set); }
    set.add(listener);
    return this;
  }

  off(event: string, listener: Function): this {
    this._listeners.get(event)?.delete(listener);
    return this;
  }

  removeListener(event: string, listener: Function): this { return this.off(event, listener); }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    if (this._hostSubscription !== null) {
      hostWatchers.delete(this._hostSubscription);
      try { call('fs.watch.unsubscribe', { id: this._hostSubscription }); } catch { /* Host may already be gone. */ }
      this._hostSubscription = null;
    }
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._pendingHostEvents.clear();
    this._emit('close', null);
    this._releaseLifecycle?.();
    this._releaseLifecycle = null;
    this._listeners.clear();
    this._snapshot.clear();
  }

  ref(): this {
    this._retainLifecycle();
    return this;
  }
  unref(): this {
    this._releaseLifecycle?.();
    this._releaseLifecycle = null;
    return this;
  }

  private _retainLifecycle(): void {
    if (!this._releaseLifecycle) this._releaseLifecycle = lifecycle()?.retain() ?? null;
  }
}

const hostWatchers = new Map<number, FSWatcher>();
(globalThis as Record<string, unknown>)['__fsWatch'] = {
  dispatch(id: number, mutation: HostMutation): void {
    hostWatchers.get(id)?._onHostMutation(mutation);
  },
};

const watch = (
  filename: string,
  optsOrListener?: WatchOptions | WatchListener,
  maybeListener?: WatchListener,
): FSWatcher => {
  let opts: WatchOptions = {};
  let listener: WatchListener | undefined;
  if (typeof optsOrListener === 'function') listener = optsOrListener;
  else if (optsOrListener && typeof optsOrListener === 'object') opts = optsOrListener;
  if (maybeListener) listener = maybeListener;
  const w = new FSWatcher(normalizePath(filename), opts);
  if (listener) w.on('change', listener as Function).on('rename', listener as Function);
  return w;
};

// ---- watchFile / unwatchFile ----

interface FileWatcher {
  curr: Stats | null;
  prev: Stats | null;
  listeners: Set<(curr: Stats, prev: Stats) => void>;
  timer: ReturnType<typeof setInterval>;
  interval: number;
}

const _fileWatchers = new Map<string, FileWatcher>();

const watchFile = (
  filename: string,
  optsOrListener: { interval?: number; persistent?: boolean } | ((curr: Stats, prev: Stats) => void),
  maybeListener?: (curr: Stats, prev: Stats) => void,
): void => {
  const filePath = normalizePath(filename);
  const opts = (typeof optsOrListener === 'object' ? optsOrListener : {}) as { interval?: number };
  const listener = (typeof optsOrListener === 'function' ? optsOrListener : maybeListener) as
    | ((curr: Stats, prev: Stats) => void)
    | undefined;
  if (!listener) return;
  const interval = opts.interval ?? 5007;
  let entry = _fileWatchers.get(filePath);
  if (!entry) {
    let initial: Stats | null = null;
    try { initial = statSync(filePath); } catch { /* */ }
    entry = {
      curr: initial,
      prev: initial,
      listeners: new Set(),
      interval,
      timer: setInterval(() => {
        const e = _fileWatchers.get(filePath);
        if (!e) return;
        let next: Stats | null = null;
        try { next = statSync(filePath); } catch { /* */ }
        if (next && e.curr) {
          if (next.mtimeMs !== e.curr.mtimeMs || next.size !== e.curr.size) {
            e.prev = e.curr;
            e.curr = next;
            for (const fn of e.listeners) {
              try { fn(next, e.prev); } catch { /* */ }
            }
          }
        } else if (next && !e.curr) {
          e.prev = next;
          e.curr = next;
          for (const fn of e.listeners) {
            try { fn(next, next); } catch { /* */ }
          }
        }
      }, interval) as unknown as ReturnType<typeof setInterval>,
    };
    _fileWatchers.set(filePath, entry);
  }
  entry.listeners.add(listener);
};

const unwatchFile = (filename: string, listener?: (curr: Stats, prev: Stats) => void): void => {
  const filePath = normalizePath(filename);
  const entry = _fileWatchers.get(filePath);
  if (!entry) return;
  if (listener) {
    entry.listeners.delete(listener);
  } else {
    entry.listeners.clear();
  }
  if (entry.listeners.size === 0) {
    clearInterval(entry.timer);
    _fileWatchers.delete(filePath);
  }
};

// ---- createReadStream / createWriteStream ----

export interface CreateReadStreamOptions {
  encoding?: string;
  start?: number;
  end?: number;
  highWaterMark?: number;
  autoClose?: boolean;
  flags?: string;
}

export const createReadStream = (path: string, opts?: CreateReadStreamOptions | string): Readable => {
  const filePath = normalizePath(path);
  const o: CreateReadStreamOptions = typeof opts === 'string' ? { encoding: opts } : (opts ?? {});
  let pushed = false;
  return new Readable({
    highWaterMark: o.highWaterMark ?? 64 * 1024,
    read() {
      if (pushed) return;
      pushed = true;
      defer(() => {
        try {
          const arr = call('fs.readFileBytes', { path: filePath }) as number[];
          const buf = Uint8Array.from(arr);
          const start = o.start ?? 0;
          const end = o.end !== undefined ? Math.min(o.end + 1, buf.length) : buf.length;
          const slice = buf.subarray(start, end);
          if (o.encoding) {
            this.push(bytesToString(slice, o.encoding));
          } else {
            this.push(slice);
          }
          this.push(null);
        } catch (e) {
          this.destroy(e as Error);
        }
      });
    },
  });
};

export interface CreateWriteStreamOptions {
  flags?: string;
  encoding?: string;
  autoClose?: boolean;
  start?: number;
}

export const createWriteStream = (path: string, opts?: CreateWriteStreamOptions | string): Writable => {
  const filePath = normalizePath(path);
  const o: CreateWriteStreamOptions = typeof opts === 'string' ? { encoding: opts } : (opts ?? {});
  const chunks: Uint8Array[] = [];
  const isAppend = o.flags === 'a' || o.flags === 'a+';
  return new Writable({
    write(chunk, _enc, cb) {
      if (typeof chunk === 'string') chunks.push(toBuffer(chunk));
      else if (chunk instanceof Uint8Array) chunks.push(chunk);
      cb();
    },
    final(cb) {
      defer(() => {
        try {
          let total = 0;
          for (const c of chunks) total += c.length;
          const combined = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) { combined.set(c, off); off += c.length; }
          let finalBytes = combined;
          if (isAppend) {
            try {
              const existing = Uint8Array.from(call('fs.readFileBytes', { path: filePath }) as number[]);
              const merged = new Uint8Array(existing.length + combined.length);
              merged.set(existing, 0);
              merged.set(combined, existing.length);
              finalBytes = merged;
            } catch { /* */ }
          }
          call('fs.writeFileBytes', { path: filePath, data: Array.from(finalBytes) });
          cb();
        } catch (e) { cb(e as Error); }
      });
    },
  });
};

// ---- mkdtemp ----

const mkdtempSync = (prefix: string): string => {
  const path = normalizePath(prefix);
  const suffix = Math.random().toString(36).slice(2, 8);
  const directory = path + suffix;
  call('fs.mkdir', { path: directory, recursive: false });
  return directory;
};

const mkdtemp = (prefix: string, optsOrCb?: unknown, maybeCb?: Cb): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as Cb | undefined;
  defer(() => {
    try { cb?.(null, mkdtempSync(prefix)); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

// ---- promises namespace ----

const promises = {
  // Default to utf8 string for backward compat with existing DuskJS code; pass
  // `{ encoding: null }` explicitly to get a Buffer. This is a slight deviation
  // from Node (which returns a Buffer when no encoding is given), but matches
  // the established surface across the project's existing tests.
  readFile: (path: string, opts?: string | { encoding?: string | null }): Promise<unknown> =>
    promiseOp(() => {
      if (opts === undefined) {
        const arr = call('fs.readFileBytes', { path: normalizePath(path) }) as number[];
        return toBuffer(Uint8Array.from(arr));
      }
      return readFileSync(path, opts as string | { encoding?: string });
    }),
  writeFile: (path: string, data: unknown): Promise<void> =>
    promiseOp(() => {
      if (typeof data !== 'string' && (data instanceof Uint8Array || Array.isArray(data))) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data as number[]);
        call('fs.writeFileBytes', { path: normalizePath(path), data: Array.from(bytes) });
        return;
      }
      writeFileSync(path, data);
    }),
  appendFile: (path: string, data: unknown): Promise<void> =>
    promiseOp(() => appendFileSync(path, data)),
  readdir: (path: string, opts?: { withFileTypes?: boolean }): Promise<string[] | Dirent[]> =>
    promiseOp(() => readdirSync(path, opts)),
  mkdir: (path: string, opts?: { recursive?: boolean }): Promise<void> =>
    promiseOp(() => mkdirSync(path, opts)),
  rm: (path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void> =>
    promiseOp(() => rmSync(path, opts)),
  rmdir: (path: string, opts?: { recursive?: boolean }): Promise<void> =>
    promiseOp(() => rmdirSync(path, opts)),
  unlink: (path: string): Promise<void> =>
    promiseOp(() => unlinkSync(path)),
  stat: (path: string): Promise<Stats> =>
    promiseOp(() => statSync(path)),
  lstat: (path: string): Promise<Stats> =>
    promiseOp(() => lstatSync(path)),
  symlink: (target: string, path: string, _type?: string): Promise<void> =>
    promiseOp(() => symlinkSync(target, path)),
  readlink: (path: string): Promise<string> =>
    promiseOp(() => readlinkSync(path)),
  rename: (from: string, to: string): Promise<void> =>
    promiseOp(() => renameSync(from, to)),
  copyFile: (src: string, dest: string): Promise<void> =>
    promiseOp(() => copyFileSync(src, dest)),
  access: (path: string): Promise<void> =>
    promiseOp(() => accessSync(path)),
  realpath: (path: string): Promise<string> =>
    promiseOp(() => realpathSync(path)),
  truncate: (path: string, len?: number): Promise<void> =>
    promiseOp(() => truncateSync(path, len)),
  chmod: (path: string, mode: number): Promise<void> =>
    promiseOp(() => chmodSync(path, mode)),
  chown: (path: string, uid: number, gid: number): Promise<void> =>
    promiseOp(() => chownSync(path, uid, gid)),
  utimes: (path: string, atime: Date | number, mtime: Date | number): Promise<void> =>
    promiseOp(() => utimesSync(path, atime, mtime)),
  mkdtemp: (prefix: string): Promise<string> =>
    promiseOp(() => mkdtempSync(prefix)),
  open: async (path: string, flags?: string | number): Promise<FileHandle> => {
    const fd = await promiseOp(() => _openSync(path, flags ?? 'r'));
    return new FileHandle(fd, path);
  },
};

class FileHandle {
  fd: number;
  path: string;
  constructor(fd: number, path: string) {
    this.fd = fd;
    this.path = path;
  }
  read(buffer: Uint8Array, offset?: number, length?: number, position?: number | null): Promise<{ bytesRead: number; buffer: Uint8Array }> {
    return promiseOp(() => {
      const n = _readSync(this.fd, buffer, offset ?? 0, length ?? buffer.length, position ?? null);
      return { bytesRead: n, buffer };
    });
  }
  write(buffer: Uint8Array | string, offset?: number, length?: number, position?: number | null): Promise<{ bytesWritten: number; buffer: Uint8Array | string }> {
    return promiseOp(() => {
      const n = _writeSync(this.fd, buffer, offset, length, position);
      return { bytesWritten: n, buffer };
    });
  }
  close(): Promise<void> {
    return promiseOp(() => _closeSync(this.fd));
  }
  stat(): Promise<Stats> {
    return promiseOp(() => _fstatSync(this.fd));
  }
  truncate(len?: number): Promise<void> {
    return promiseOp(() => _ftruncateSync(this.fd, len));
  }
  sync(): Promise<void> {
    return promiseOp(() => _fsyncSync(this.fd));
  }
  datasync(): Promise<void> {
    return promiseOp(() => _fsyncSync(this.fd));
  }
  readFile(opts?: string | { encoding?: string }): Promise<unknown> {
    return promiseOp(() => readFileSync(this.path, opts));
  }
  writeFile(data: unknown): Promise<void> {
    return promiseOp(() => writeFileSync(this.path, data));
  }
}

// ---- constants ----

const constants = {
  F_OK: 0, X_OK: 1, W_OK: 2, R_OK: 4,
  O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2,
  O_CREAT: 0o100, O_EXCL: 0o200, O_TRUNC: 0o1000, O_APPEND: 0o2000,
};

export const nodeFs = {
  // async callback
  readFile,
  writeFile,
  appendFile,
  readdir,
  mkdir,
  rm,
  rmdir,
  unlink,
  exists,
  stat,
  lstat,
  symlink,
  readlink,
  rename,
  copyFile,
  access,
  realpath,
  open,
  close,
  read,
  write,
  fstat,
  ftruncate,
  fsync,
  fdatasync,
  truncate,
  chmod, fchmod, lchmod,
  chown, fchown, lchown,
  utimes, lutimes, futimes,
  mkdtemp,
  watch,
  watchFile,
  unwatchFile,
  // sync
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  mkdirSync,
  rmSync,
  rmdirSync,
  unlinkSync,
  existsSync,
  statSync,
  lstatSync,
  symlinkSync,
  readlinkSync,
  renameSync,
  copyFileSync,
  accessSync,
  realpathSync: Object.assign(realpathSync, { native: realpathSync }),
  truncateSync,
  chmodSync, fchmodSync, lchmodSync,
  chownSync, fchownSync, lchownSync,
  utimesSync, lutimesSync, futimesSync,
  mkdtempSync,
  openSync: _openSync,
  closeSync: _closeSync,
  readSync: _readSync,
  writeSync: _writeSync,
  fstatSync: _fstatSync,
  fsyncSync: _fsyncSync,
  fdatasyncSync: _fsyncSync,
  ftruncateSync: _ftruncateSync,
  // streams
  createReadStream,
  createWriteStream,
  // misc
  Stats,
  FSWatcher,
  constants,
  promises,
};
