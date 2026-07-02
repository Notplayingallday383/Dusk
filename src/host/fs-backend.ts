import { createVFS, decodeUtf8 } from './vfs';

export interface FSCaller {
  pid: number;
}

export interface FSStat {
  isFile: boolean;
  isDirectory: boolean;
}

export interface FSReadResult { bytes: Uint8Array; bytesRead: number; }
export interface FSWriteResult { bytesWritten: number; }
export interface FSFstat { isFile: boolean; isDirectory: boolean; size: number; }

// Flag constants — match Node's posix values exactly.
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;

export interface FSBackend {
  readFile(path: string, caller?: FSCaller): Promise<string>;
  writeFile(path: string, data: string, caller?: FSCaller): Promise<void>;
  readFileBytes(path: string, caller?: FSCaller): Promise<Uint8Array>;
  writeFileBytes(path: string, data: Uint8Array, caller?: FSCaller): Promise<void>;
  readdir(path: string, caller?: FSCaller): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }, caller?: FSCaller): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }, caller?: FSCaller): Promise<void>;
  exists(path: string, caller?: FSCaller): Promise<boolean>;
  stat(path: string, caller?: FSCaller): Promise<FSStat>;
  rename(from: string, to: string, caller?: FSCaller): Promise<void>;
  // fd ops — backend-local handle space; ProcessManager maps per-pid fd -> handle.
  openHandle(path: string, flags: number, caller?: FSCaller): Promise<{ handle: number; size: number; appendOnly: boolean }>;
  readHandle(handle: number, length: number, position: number, caller?: FSCaller): Promise<FSReadResult>;
  writeHandle(handle: number, data: Uint8Array, position: number, caller?: FSCaller): Promise<FSWriteResult>;
  closeHandle(handle: number, caller?: FSCaller): Promise<void>;
  fstatHandle(handle: number, caller?: FSCaller): Promise<FSFstat>;
  ftruncateHandle(handle: number, length: number, caller?: FSCaller): Promise<void>;
  fsyncHandle(handle: number, caller?: FSCaller): Promise<void>;
  // Symlinks (optional; backends may stub):
  symlink?(target: string, path: string, caller?: FSCaller): Promise<void>;
  readlink?(path: string, caller?: FSCaller): Promise<string>;
  lstat?(path: string, caller?: FSCaller): Promise<FSStat & { isSymlink?: boolean }>;
}

const errWithCode = (msg: string, code: string): Error & { code?: string } => {
  const e: Error & { code?: string } = new Error(msg);
  e.code = code;
  return e;
};

export const createMemoryBackend = (): FSBackend => {
  const vfs = createVFS();
  interface Handle { path: string; flags: number; appendOnly: boolean; closed: boolean; }
  const handles = new Map<number, Handle>();
  let nextHandle = 1;

  return {
    readFile: async (path) => vfs.readFile(path),
    writeFile: async (path, data) => { vfs.writeFile(path, data); },
    readFileBytes: async (path) => vfs.readFileBytes(path),
    writeFileBytes: async (path, data) => { vfs.writeFileBytes(path, data); },
    readdir: async (path) => vfs.readdir(path),
    mkdir: async (path, opts) => { vfs.mkdir(path, opts); },
    rm: async (path) => { vfs.rm(path); },
    exists: async (path) => vfs.exists(path),
    stat: async (path) => vfs.stat(path),
    rename: async (from, to) => { vfs.rename(from, to); },
    symlink: async (target, path) => { vfs.symlink(target, path); },
    readlink: async (path) => vfs.readlink(path),
    lstat: async (path) => vfs.lstat(path),

    openHandle: async (path, flags) => {
      const exists = vfs.exists(path);
      if (!exists && (flags & O_CREAT) !== 0) vfs.writeFileBytes(path, new Uint8Array(0));
      else if (!exists) throw errWithCode('ENOENT: ' + path, 'ENOENT');
      if ((flags & O_EXCL) !== 0 && exists) throw errWithCode('EEXIST: ' + path, 'EEXIST');
      if ((flags & O_TRUNC) !== 0) vfs.writeFileBytes(path, new Uint8Array(0));
      const appendOnly = (flags & O_APPEND) !== 0;
      const size = vfs.fileSize(path);
      const handle = nextHandle++;
      handles.set(handle, { path, flags, appendOnly, closed: false });
      return { handle, size, appendOnly };
    },
    readHandle: async (handle, length, position) => {
      const h = handles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const all = vfs.readFileBytes(h.path);
      const start = Math.max(0, Math.min(position, all.length));
      const end = Math.min(all.length, start + length);
      const slice = all.subarray(start, end);
      const out = new Uint8Array(slice.length);
      out.set(slice);
      return { bytes: out, bytesRead: out.length };
    },
    writeHandle: async (handle, data, position) => {
      const h = handles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const cur = vfs.readFileBytes(h.path);
      const writePos = h.appendOnly ? cur.length : Math.max(0, position);
      const end = writePos + data.length;
      const next = new Uint8Array(Math.max(cur.length, end));
      next.set(cur);
      next.set(data, writePos);
      vfs.writeFileBytes(h.path, next);
      return { bytesWritten: data.length };
    },
    closeHandle: async (handle) => {
      const h = handles.get(handle);
      if (!h) throw errWithCode('EBADF', 'EBADF');
      h.closed = true;
      handles.delete(handle);
    },
    fstatHandle: async (handle) => {
      const h = handles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const s = vfs.stat(h.path);
      return { isFile: s.isFile, isDirectory: s.isDirectory, size: vfs.fileSize(h.path) };
    },
    ftruncateHandle: async (handle, length) => {
      const h = handles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const cur = vfs.readFileBytes(h.path);
      const next = new Uint8Array(length);
      next.set(cur.subarray(0, Math.min(cur.length, length)));
      vfs.writeFileBytes(h.path, next);
    },
    fsyncHandle: async () => { /* memory backend is synchronous; nothing to flush */ },
  };
};

interface TfsFsPromises {
  readFile(file: string, type?: string): Promise<unknown>;
  writeFile(file: string, content: string | ArrayBuffer | Uint8Array, type?: string): Promise<void>;
  readdir(dir: string, opts?: { recursive?: boolean }): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  rmdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean } | null>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

interface TfsInstance { fs: { promises: TfsFsPromises } }

const toUint8 = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  // Some hosts might yield typed arrays that share buffer:
  if (v && typeof v === 'object' && 'byteLength' in (v as object) && 'buffer' in (v as object)) {
    const av = v as ArrayBufferView;
    return new Uint8Array(av.buffer, av.byteOffset, av.byteLength).slice();
  }
  throw new Error('TFS readFile(arraybuffer) returned unexpected type: ' + Object.prototype.toString.call(v));
};

export const createTfsBackend = async (): Promise<FSBackend> => {
  const { TFS } = (await import('@terbiumos/tfs/browser')) as unknown as {
    TFS: { init(): Promise<TfsInstance> };
  };
  const tfs = await TFS.init();
  const p = tfs.fs.promises;
  const ensureParents = async (path: string): Promise<void> => {
    const segs = path.split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      if (!(await p.exists(cur))) await p.mkdir(cur);
    }
  };

  // Simulated fd cache for TFS (TFS exposes only whole-file ops).
  interface TfsHandle { path: string; flags: number; appendOnly: boolean; contents: Uint8Array; dirty: boolean; closed: boolean; }
  const tfsHandles = new Map<number, TfsHandle>();
  let nextTfsHandle = 1;

  const readBytes = async (path: string): Promise<Uint8Array> => {
    const raw = await p.readFile(path, 'arraybuffer');
    return toUint8(raw);
  };
  const writeBytes = async (path: string, data: Uint8Array): Promise<void> => {
    await ensureParents(path);
    // Copy into a stand-alone ArrayBuffer to avoid transfer issues.
    const ab = new Uint8Array(data.length);
    ab.set(data);
    await p.writeFile(path, ab.buffer, 'arraybuffer');
  };

  return {
    readFile: async (path) => {
      // Preserve utf-8 semantics for string API by decoding bytes; TFS's utf8 path also
      // works but going through bytes ensures byte-safety when files were written binary.
      try {
        return decodeUtf8(await readBytes(path));
      } catch {
        return String(await p.readFile(path, 'utf8'));
      }
    },
    writeFile: async (path, data) => {
      await ensureParents(path);
      await p.writeFile(path, data, 'utf8');
    },
    readFileBytes: async (path) => readBytes(path),
    writeFileBytes: async (path, data) => { await writeBytes(path, data); },
    readdir: async (path) => p.readdir(path),
    mkdir: async (path, opts) => {
      if (opts?.recursive) {
        const segs = path.split('/').filter(Boolean);
        let cur = '';
        for (const s of segs) { cur += '/' + s; if (!(await p.exists(cur))) await p.mkdir(cur); }
      } else {
        await p.mkdir(path);
      }
    },
    rm: async (path, opts) => {
      const st = await p.stat(path);
      if (st && st.isDirectory()) await p.rmdir(path, { recursive: opts?.recursive ?? true });
      else await p.unlink(path);
    },
    exists: async (path) => p.exists(path),
    stat: async (path) => {
      const st = await p.stat(path);
      if (!st) throw new Error('ENOENT: ' + path);
      return { isFile: st.isFile(), isDirectory: st.isDirectory() };
    },
    rename: async (from, to) => { await p.rename(from, to); },

    openHandle: async (path, flags) => {
      const exists = await p.exists(path);
      if (!exists && (flags & O_CREAT) !== 0) {
        await ensureParents(path);
        await writeBytes(path, new Uint8Array(0));
      } else if (!exists) {
        throw errWithCode('ENOENT: ' + path, 'ENOENT');
      }
      if ((flags & O_EXCL) !== 0 && exists) throw errWithCode('EEXIST: ' + path, 'EEXIST');
      const contents = (flags & O_TRUNC) ? new Uint8Array(0) : await readBytes(path);
      if ((flags & O_TRUNC) !== 0) await writeBytes(path, contents);
      const appendOnly = (flags & O_APPEND) !== 0;
      const handle = nextTfsHandle++;
      tfsHandles.set(handle, { path, flags, appendOnly, contents, dirty: false, closed: false });
      return { handle, size: contents.length, appendOnly };
    },
    readHandle: async (handle, length, position) => {
      const h = tfsHandles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const start = Math.max(0, Math.min(position, h.contents.length));
      const end = Math.min(h.contents.length, start + length);
      const out = h.contents.slice(start, end);
      return { bytes: out, bytesRead: out.length };
    },
    writeHandle: async (handle, data, position) => {
      const h = tfsHandles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const writePos = h.appendOnly ? h.contents.length : Math.max(0, position);
      const end = writePos + data.length;
      const next = new Uint8Array(Math.max(h.contents.length, end));
      next.set(h.contents);
      next.set(data, writePos);
      h.contents = next;
      h.dirty = true;
      return { bytesWritten: data.length };
    },
    closeHandle: async (handle) => {
      const h = tfsHandles.get(handle);
      if (!h) throw errWithCode('EBADF', 'EBADF');
      if (h.dirty) await writeBytes(h.path, h.contents);
      h.closed = true;
      tfsHandles.delete(handle);
    },
    fstatHandle: async (handle) => {
      const h = tfsHandles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      return { isFile: true, isDirectory: false, size: h.contents.length };
    },
    ftruncateHandle: async (handle, length) => {
      const h = tfsHandles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const next = new Uint8Array(length);
      next.set(h.contents.subarray(0, Math.min(h.contents.length, length)));
      h.contents = next;
      h.dirty = true;
    },
    fsyncHandle: async (handle) => {
      const h = tfsHandles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      if (h.dirty) { await writeBytes(h.path, h.contents); h.dirty = false; }
    },
  };
};

