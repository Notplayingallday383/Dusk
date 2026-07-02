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
    const now = Date.now();
    this.mtimeMs = raw.mtimeMs ?? now;
    this.atimeMs = raw.atimeMs ?? now;
    this.ctimeMs = raw.ctimeMs ?? now;
    this.birthtimeMs = raw.birthtimeMs ?? now;
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
  return call('fs.open', { path, flags, mode }) as number;
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
  const data = call('fs.readFile', { path }) as string;
  const encoding = typeof optsOrEnc === 'string' ? optsOrEnc : optsOrEnc?.encoding;
  if (encoding) return data; // already string; FS backend returns utf8
  return toBuffer(data);
};

const writeFileSync = (path: string, data: unknown, _opts?: unknown): void => {
  const text = typeof data === 'string' ? data : bytesToString(toBuffer(data), 'utf8');
  call('fs.writeFile', { path, data: text });
};

const appendFileSync = (path: string, data: unknown, _opts?: unknown): void => {
  let existing = '';
  try { existing = call('fs.readFile', { path }) as string; } catch { /* */ }
  const text = typeof data === 'string' ? data : bytesToString(toBuffer(data), 'utf8');
  call('fs.writeFile', { path, data: existing + text });
};

const readdirSync = (path: string, _opts?: unknown): string[] => {
  return call('fs.readdir', { path }) as string[];
};

const mkdirSync = (path: string, opts?: { recursive?: boolean } | number): void => {
  const recursive = typeof opts === 'object' && opts ? opts.recursive : false;
  call('fs.mkdir', { path, recursive: Boolean(recursive) });
};

const rmSync = (path: string, opts?: { recursive?: boolean; force?: boolean }): void => {
  try { call('fs.rm', { path, recursive: Boolean(opts?.recursive) }); }
  catch (e) { if (!opts?.force) throw e; }
};

const rmdirSync = (path: string, opts?: { recursive?: boolean }): void => {
  call('fs.rm', { path, recursive: Boolean(opts?.recursive) });
};

const unlinkSync = (path: string): void => {
  call('fs.rm', { path, recursive: false });
};

const existsSync = (path: string): boolean => {
  try { return call('fs.exists', { path }) === true; } catch { return false; }
};

const statSync = (path: string, _opts?: unknown): Stats => {
  return wrapStat(call('fs.stat', { path }) as RawStat);
};

const lstatSync = (path: string): Stats => {
  try {
    return wrapStat(call('fs.lstat', { path }) as RawStat);
  } catch {
    return wrapStat(call('fs.stat', { path }) as RawStat);
  }
};

const symlinkSync = (target: string, path: string, _type?: string): void => {
  call('fs.symlink', { target, path });
};

const readlinkSync = (path: string, _opts?: unknown): string => {
  return call('fs.readlink', { path }) as string;
};

const renameSync = (from: string, to: string): void => {
  call('fs.rename', { from, to });
};

const copyFileSync = (src: string, dest: string, _mode?: number): void => {
  const data = call('fs.readFile', { path: src }) as string;
  call('fs.writeFile', { path: dest, data });
};

const accessSync = (path: string, _mode?: number): void => {
  if (call('fs.exists', { path }) !== true) {
    throw errnoError('ENOENT', 'access', path);
  }
};

const realpathSync = (path: string): string => {
  // No symlinks yet — return path as-is if it exists
  if (call('fs.exists', { path }) !== true) {
    throw errnoError('ENOENT', 'realpath', path);
  }
  return path;
};

const truncateSync = (path: string, len = 0): void => {
  let existing = '';
  try { existing = call('fs.readFile', { path }) as string; } catch { /* */ }
  const bytes = toBuffer(existing);
  if (len < bytes.length) call('fs.writeFile', { path, data: bytesToString(bytes.subarray(0, len), 'utf8') });
  else if (len > bytes.length) {
    const expanded = new Uint8Array(len);
    expanded.set(bytes);
    call('fs.writeFile', { path, data: bytesToString(expanded, 'utf8') });
  }
};

const chmodSync = (_path: string, _mode: number): void => { /* no-op */ };
const fchmodSync = (_fd: number, _mode: number): void => { /* no-op */ };
const lchmodSync = chmodSync;
const chownSync = (_path: string, _uid: number, _gid: number): void => { /* no-op */ };
const fchownSync = (_fd: number, _uid: number, _gid: number): void => { /* no-op */ };
const lchownSync = chownSync;
const utimesSync = (_path: string, _atime: Date | number, _mtime: Date | number): void => { /* no-op */ };
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
  defer(() => {
    try { cb?.(null, readdirSync(path)); }
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

// ---- watch / watchFile / unwatchFile (poll-based) ----
//
// FS backends here don't expose change events, so we poll stat() at an interval.
// This matches Node's `fs.watchFile` semantics and is a reasonable approximation
// of `fs.watch` for code that just needs to be notified.

type WatchListener = (event: 'rename' | 'change', filename: string | null) => void;

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
  // Snapshot: path → (mtime, size, isDir, dirEntries set)
  private _snapshot: Map<string, { mtime: number; size: number; isDir: boolean; entries?: Set<string> }> = new Map();

  constructor(p: string, opts: WatchOptions = {}) {
    this._path = p;
    this._interval = opts.interval ?? 1000;
    this._recursive = !!opts.recursive;
    this._buildSnapshot(this._path);
    this._timer = setInterval(() => this._poll(), this._interval) as unknown as ReturnType<typeof setInterval>;
  }

  private _buildSnapshot(p: string): void {
    try {
      const st = statSync(p);
      const entry: { mtime: number; size: number; isDir: boolean; entries?: Set<string> } = {
        mtime: st.mtimeMs,
        size: st.size,
        isDir: st.isDirectory(),
      };
      if (entry.isDir) {
        try {
          entry.entries = new Set(readdirSync(p));
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
        this._snapshot.delete(p);
        this._emit('rename', this._relativeName(p));
      }
      return;
    }
    if (!prev) {
      // New
      const entry: { mtime: number; size: number; isDir: boolean; entries?: Set<string> } = {
        mtime: st.mtimeMs,
        size: st.size,
        isDir: st.isDirectory(),
      };
      if (entry.isDir) {
        try { entry.entries = new Set(readdirSync(p)); } catch { /* */ }
      }
      this._snapshot.set(p, entry);
      this._emit('rename', this._relativeName(p));
      if (this._recursive && entry.entries) {
        for (const child of entry.entries) {
          this._diffSubtree(p + '/' + child);
        }
      }
      return;
    }
    // Check for changes to this entry
    if (prev.mtime !== st.mtimeMs || prev.size !== st.size) {
      prev.mtime = st.mtimeMs;
      prev.size = st.size;
      this._emit('change', this._relativeName(p));
    }
    // For directories, compare entry sets
    if (st.isDirectory()) {
      let current: Set<string>;
      try { current = new Set(readdirSync(p)); }
      catch { return; }
      const prevSet = prev.entries ?? new Set<string>();
      // Detect additions/removals
      for (const name of current) {
        if (!prevSet.has(name)) {
          this._emit('rename', name);
          if (this._recursive) {
            this._diffSubtree(p + '/' + name);
          }
        }
      }
      for (const name of prevSet) {
        if (!current.has(name)) {
          this._emit('rename', name);
          this._snapshot.delete(p + '/' + name);
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
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._listeners.clear();
    this._snapshot.clear();
    this._emit('close', null);
  }

  ref(): this { return this; }
  unref(): this { return this; }
}

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
  const w = new FSWatcher(filename, opts);
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
  const opts = (typeof optsOrListener === 'object' ? optsOrListener : {}) as { interval?: number };
  const listener = (typeof optsOrListener === 'function' ? optsOrListener : maybeListener) as
    | ((curr: Stats, prev: Stats) => void)
    | undefined;
  if (!listener) return;
  const interval = opts.interval ?? 5007;
  let entry = _fileWatchers.get(filename);
  if (!entry) {
    let initial: Stats | null = null;
    try { initial = statSync(filename); } catch { /* */ }
    entry = {
      curr: initial,
      prev: initial,
      listeners: new Set(),
      interval,
      timer: setInterval(() => {
        const e = _fileWatchers.get(filename);
        if (!e) return;
        let next: Stats | null = null;
        try { next = statSync(filename); } catch { /* */ }
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
    _fileWatchers.set(filename, entry);
  }
  entry.listeners.add(listener);
};

const unwatchFile = (filename: string, listener?: (curr: Stats, prev: Stats) => void): void => {
  const entry = _fileWatchers.get(filename);
  if (!entry) return;
  if (listener) {
    entry.listeners.delete(listener);
  } else {
    entry.listeners.clear();
  }
  if (entry.listeners.size === 0) {
    clearInterval(entry.timer);
    _fileWatchers.delete(filename);
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
  const o: CreateReadStreamOptions = typeof opts === 'string' ? { encoding: opts } : (opts ?? {});
  let pushed = false;
  return new Readable({
    highWaterMark: o.highWaterMark ?? 64 * 1024,
    read() {
      if (pushed) return;
      pushed = true;
      defer(() => {
        try {
          const arr = call('fs.readFileBytes', { path }) as number[];
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
              const existing = Uint8Array.from(call('fs.readFileBytes', { path }) as number[]);
              const merged = new Uint8Array(existing.length + combined.length);
              merged.set(existing, 0);
              merged.set(combined, existing.length);
              finalBytes = merged;
            } catch { /* */ }
          }
          call('fs.writeFileBytes', { path, data: Array.from(finalBytes) });
          cb();
        } catch (e) { cb(e as Error); }
      });
    },
  });
};

// ---- mkdtemp ----

const mkdtempSync = (prefix: string): string => {
  const suffix = Math.random().toString(36).slice(2, 8);
  const path = prefix + suffix;
  call('fs.mkdir', { path, recursive: false });
  return path;
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
        const arr = call('fs.readFileBytes', { path }) as number[];
        return toBuffer(Uint8Array.from(arr));
      }
      return readFileSync(path, opts as string | { encoding?: string });
    }),
  writeFile: (path: string, data: unknown): Promise<void> =>
    promiseOp(() => {
      if (typeof data !== 'string' && (data instanceof Uint8Array || Array.isArray(data))) {
        const bytes = data instanceof Uint8Array ? data : Uint8Array.from(data as number[]);
        call('fs.writeFileBytes', { path, data: Array.from(bytes) });
        return;
      }
      writeFileSync(path, data);
    }),
  appendFile: (path: string, data: unknown): Promise<void> =>
    promiseOp(() => appendFileSync(path, data)),
  readdir: (path: string): Promise<string[]> =>
    promiseOp(() => readdirSync(path)),
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
  realpathSync,
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
