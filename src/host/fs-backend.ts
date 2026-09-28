import { createVFS, decodeUtf8, norm } from './vfs';

export interface FSCaller {
  pid: number;
}

export interface FSStat {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

export interface FSReadResult { bytes: Uint8Array; bytesRead: number; }
export interface FSWriteResult { bytesWritten: number; }
export interface FSFstat extends FSStat {}
export interface FSMutation {
  type: 'write' | 'mkdir' | 'rename' | 'rm';
  path: string;
  previousPath?: string;
}

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
  subscribe(listener: (event: FSMutation) => void): () => void;
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
  const listeners = new Set<(event: FSMutation) => void>();
  const emit = (event: FSMutation): void => {
    const normalized = event.previousPath === undefined
      ? { ...event, path: norm(event.path) }
      : { ...event, path: norm(event.path), previousPath: norm(event.previousPath) };
    for (const listener of listeners) {
      try { listener(normalized); } catch { /* Listeners cannot invalidate completed mutations. */ }
    }
  };
  let nextHandle = 1;

  return {
    readFile: async (path) => vfs.readFile(path),
    writeFile: async (path, data) => { vfs.writeFile(path, data); emit({ type: 'write', path }); },
    readFileBytes: async (path) => vfs.readFileBytes(path),
    writeFileBytes: async (path, data) => { vfs.writeFileBytes(path, data); emit({ type: 'write', path }); },
    readdir: async (path) => vfs.readdir(path),
    mkdir: async (path, opts) => { vfs.mkdir(path, opts); emit({ type: 'mkdir', path }); },
    rm: async (path) => { vfs.rm(path); emit({ type: 'rm', path }); },
    exists: async (path) => vfs.exists(path),
    stat: async (path) => vfs.stat(path),
    rename: async (from, to) => { vfs.rename(from, to); emit({ type: 'rename', path: to, previousPath: from }); },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    symlink: async (target, path) => { vfs.symlink(target, path); },
    readlink: async (path) => vfs.readlink(path),
    lstat: async (path) => vfs.lstat(path),

    openHandle: async (path, flags) => {
      const exists = vfs.exists(path);
      if (!exists && (flags & O_CREAT) !== 0) { vfs.writeFileBytes(path, new Uint8Array(0)); emit({ type: 'write', path }); }
      else if (!exists) throw errWithCode('ENOENT: ' + path, 'ENOENT');
      if ((flags & O_EXCL) !== 0 && exists) throw errWithCode('EEXIST: ' + path, 'EEXIST');
      if ((flags & O_TRUNC) !== 0) { vfs.writeFileBytes(path, new Uint8Array(0)); emit({ type: 'write', path }); }
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
      emit({ type: 'write', path: h.path });
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
      return s;
    },
    ftruncateHandle: async (handle, length) => {
      const h = handles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      const cur = vfs.readFileBytes(h.path);
      const next = new Uint8Array(length);
      next.set(cur.subarray(0, Math.min(cur.length, length)));
      vfs.writeFileBytes(h.path, next);
      emit({ type: 'write', path: h.path });
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

interface TfsState { promises: TfsFsPromises; perms: Record<string, unknown> }
interface TfsInstance { handle: FileSystemDirectoryHandle; fs: TfsState; shell: { fs: TfsState } }

interface TfsMetadata {
  mtimeMs: number;
  atimeMs: number;
  ctimeMs: number;
  birthtimeMs: number;
}

const TFS_METADATA_PATH = '/.dusk-metadata.json';
const TFS_STORE_PATH = '.TFS_STORE';
const TFS_MUTATION_LOCK = 'dusk-tfs-metadata';

const withTfsMutationLock = <T>(task: () => Promise<T>): Promise<T> => {
  const locks = navigator.locks;
  if (!locks) return Promise.reject(new Error('Persistent TFS backend requires the Web Locks API for origin-wide metadata serialization'));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('Timed out waiting for TFS metadata lock')), 5_000);
  return (async () => {
    try {
      return await locks.request(TFS_MUTATION_LOCK, { mode: 'exclusive', signal: controller.signal }, async () => task());
    } finally {
      clearTimeout(timeout);
    }
  })();
};

const initializeTfsStore = async (): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(TFS_STORE_PATH, { create: true });
  if ((await handle.getFile()).size > 0) return;
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify({
    '/.TFS_STORE': { perms: ['r'], uid: 0, gid: 0 },
  }, null, 2));
  await writable.close();
};

const waitForTfsInitialization = async (tfs: TfsInstance): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (!tfs.fs.perms['/.TFS_STORE'] || !tfs.shell.fs.perms['/.TFS_STORE']) {
    if (Date.now() >= deadline) throw new Error('TFS initialization did not complete');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

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
  if (!navigator.locks) throw new Error('Persistent TFS backend requires the Web Locks API for origin-wide metadata serialization');
  await initializeTfsStore();
  const { TFS } = (await import('@terbiumos/tfs/browser')) as unknown as {
    TFS: { init(): Promise<TfsInstance> };
  };
  const tfs = await TFS.init();
  await waitForTfsInitialization(tfs);
  const p = tfs.fs.promises;
  const waitForTfsPermission = async (path: string): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (true) {
      try {
        const handle = await tfs.handle.getFileHandle(TFS_STORE_PATH);
        const permissions = JSON.parse(await (await handle.getFile()).text()) as Record<string, unknown>;
        if (permissions[norm(path)]) return;
      } catch { /* TFS may still have its metadata file open for writing. */ }
      if (Date.now() >= deadline) throw new Error(`TFS metadata did not persist ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  const metadata = new Map<string, TfsMetadata>();
  let lastTimestamp = 0;
  const readPersistedMetadata = async (): Promise<Map<string, TfsMetadata>> => {
    const persisted = new Map<string, TfsMetadata>();
    if (!(await p.exists(TFS_METADATA_PATH))) return persisted;
    const stored = JSON.parse(String(await p.readFile(TFS_METADATA_PATH, 'utf8'))) as Record<string, TfsMetadata>;
    for (const [path, value] of Object.entries(stored)) {
      if (typeof value?.mtimeMs !== 'number' || typeof value.atimeMs !== 'number'
        || typeof value.ctimeMs !== 'number' || typeof value.birthtimeMs !== 'number') continue;
      persisted.set(path, value);
    }
    return persisted;
  };
  const syncMetadataCache = (latest: Map<string, TfsMetadata>): void => {
    metadata.clear();
    lastTimestamp = 0;
    for (const [path, value] of latest) {
      metadata.set(path, value);
      lastTimestamp = Math.max(lastTimestamp, value.mtimeMs, value.atimeMs, value.ctimeMs, value.birthtimeMs);
    }
  };
  syncMetadataCache(await readPersistedMetadata());
  const timestamp = (latest: Map<string, TfsMetadata>): number => {
    for (const value of latest.values()) {
      lastTimestamp = Math.max(lastTimestamp, value.mtimeMs, value.atimeMs, value.ctimeMs, value.birthtimeMs);
    }
    lastTimestamp = Math.max(Date.now(), lastTimestamp + 1);
    return lastTimestamp;
  };
  const updateMetadataUnlocked = async <T>(mutate: (latest: Map<string, TfsMetadata>) => T): Promise<T> => {
    const latest = await readPersistedMetadata();
    const result = mutate(latest);
    await p.writeFile(TFS_METADATA_PATH, JSON.stringify(Object.fromEntries(latest)), 'utf8');
    await waitForTfsPermission(TFS_METADATA_PATH);
    syncMetadataCache(latest);
    return result;
  };
  const metadataForUnlocked = async (path: string): Promise<TfsMetadata> => updateMetadataUnlocked((latest) => {
    const existing = latest.get(path);
    if (existing) return existing;
    const now = timestamp(latest);
    const created = { mtimeMs: now, atimeMs: now, ctimeMs: now, birthtimeMs: now };
    latest.set(path, created);
    return created;
  });
  const metadataFor = (path: string): Promise<TfsMetadata> =>
    withTfsMutationLock(() => metadataForUnlocked(path));
  const touchUnlocked = async (path: string): Promise<void> => {
    await updateMetadataUnlocked((latest) => {
      const existing = latest.get(path);
      const now = timestamp(latest);
      latest.set(path, existing
        ? { ...existing, mtimeMs: now, ctimeMs: now }
        : { mtimeMs: now, atimeMs: now, ctimeMs: now, birthtimeMs: now });
    });
  };
  const removeMetadataUnlocked = async (path: string): Promise<void> => {
    await updateMetadataUnlocked((latest) => {
      for (const key of latest.keys()) {
        if (key === path || key.startsWith(path + '/')) latest.delete(key);
      }
    });
  };
  const moveMetadataUnlocked = async (from: string, to: string): Promise<void> => {
    await updateMetadataUnlocked((latest) => {
      const moved = [...latest.entries()].filter(([path]) => path === from || path.startsWith(from + '/'));
      for (const [path] of moved) latest.delete(path);
      for (const [path, value] of moved) latest.set(to + path.slice(from.length), value);
    });
  };
  const listeners = new Set<(event: FSMutation) => void>();
  const emit = (event: FSMutation): void => {
    const normalized = event.previousPath === undefined
      ? { ...event, path: norm(event.path) }
      : { ...event, path: norm(event.path), previousPath: norm(event.previousPath) };
    for (const listener of listeners) {
      try { listener(normalized); } catch { /* Listeners cannot invalidate completed mutations. */ }
    }
  };
  const ensureParents = async (path: string): Promise<void> => {
    const segs = path.split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) {
      cur += '/' + s;
      if (!(await p.exists(cur))) {
        await p.mkdir(cur);
        await waitForTfsPermission(cur);
        await touchUnlocked(cur);
      }
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
    await waitForTfsPermission(path);
    await touchUnlocked(path);
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
      await withTfsMutationLock(async () => {
        await ensureParents(path);
        await p.writeFile(path, data, 'utf8');
        await waitForTfsPermission(path);
        await touchUnlocked(path);
      });
      emit({ type: 'write', path });
    },
    readFileBytes: async (path) => readBytes(path),
    writeFileBytes: async (path, data) => {
      await withTfsMutationLock(() => writeBytes(path, data));
      emit({ type: 'write', path });
    },
    readdir: async (path) => (await p.readdir(path)).filter((entry) => !(norm(path) === '/' && entry === TFS_METADATA_PATH.slice(1))),
    mkdir: async (path, opts) => {
      await withTfsMutationLock(async () => {
        if (opts?.recursive) {
          const segs = path.split('/').filter(Boolean);
          let cur = '';
          for (const s of segs) {
            cur += '/' + s;
            if (!(await p.exists(cur))) {
              await p.mkdir(cur);
              await waitForTfsPermission(cur);
              await touchUnlocked(cur);
            }
          }
        } else {
          await p.mkdir(path);
          await waitForTfsPermission(path);
          await touchUnlocked(path);
        }
      });
      emit({ type: 'mkdir', path });
    },
    rm: async (path, opts) => {
      await withTfsMutationLock(async () => {
        const st = await p.stat(path);
        if (st && st.isDirectory()) await p.rmdir(path, { recursive: opts?.recursive ?? true });
        else await p.unlink(path);
        await removeMetadataUnlocked(path);
      });
      emit({ type: 'rm', path });
    },
    exists: async (path) => p.exists(path),
    stat: async (path) => {
      const st = await p.stat(path);
      if (!st) throw new Error('ENOENT: ' + path);
      const isFile = st.isFile();
      const size = isFile ? (await readBytes(path)).length : 0;
      return { isFile, isDirectory: st.isDirectory(), size, ...await metadataFor(path) };
    },
    rename: async (from, to) => {
      await withTfsMutationLock(async () => {
        await metadataForUnlocked(from);
        await p.rename(from, to);
        await moveMetadataUnlocked(from, to);
      });
      emit({ type: 'rename', path: to, previousPath: from });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    openHandle: async (path, flags) => withTfsMutationLock(async () => {
        const exists = await p.exists(path);
        if (!exists && (flags & O_CREAT) !== 0) {
          await ensureParents(path);
          await writeBytes(path, new Uint8Array(0));
          emit({ type: 'write', path });
        } else if (!exists) {
          throw errWithCode('ENOENT: ' + path, 'ENOENT');
        }
        if ((flags & O_EXCL) !== 0 && exists) throw errWithCode('EEXIST: ' + path, 'EEXIST');
        const contents = (flags & O_TRUNC) ? new Uint8Array(0) : await readBytes(path);
        if ((flags & O_TRUNC) !== 0) { await writeBytes(path, contents); emit({ type: 'write', path }); }
        const appendOnly = (flags & O_APPEND) !== 0;
        const handle = nextTfsHandle++;
        tfsHandles.set(handle, { path, flags, appendOnly, contents, dirty: false, closed: false });
        return { handle, size: contents.length, appendOnly };
      }),
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
      if (h.dirty) {
        await withTfsMutationLock(() => writeBytes(h.path, h.contents));
        emit({ type: 'write', path: h.path });
      }
      h.closed = true;
      tfsHandles.delete(handle);
    },
    fstatHandle: async (handle) => {
      const h = tfsHandles.get(handle);
      if (!h || h.closed) throw errWithCode('EBADF', 'EBADF');
      return { isFile: true, isDirectory: false, size: h.contents.length, ...await metadataFor(h.path) };
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
      if (h.dirty) {
        await withTfsMutationLock(() => writeBytes(h.path, h.contents));
        h.dirty = false;
        emit({ type: 'write', path: h.path });
      }
    },
  };
};
