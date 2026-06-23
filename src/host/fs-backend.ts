import { createVFS } from './vfs';

export interface FSBackend {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exists(path: string): Promise<boolean>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean }>;
  rename(from: string, to: string): Promise<void>;
}

export const createMemoryBackend = (): FSBackend => {
  const vfs = createVFS();
  return {
    readFile: async (path) => vfs.readFile(path),
    writeFile: async (path, data) => { vfs.writeFile(path, data); },
    readdir: async (path) => vfs.readdir(path),
    mkdir: async (path, opts) => { vfs.mkdir(path, opts); },
    rm: async (path) => { vfs.rm(path); },
    exists: async (path) => vfs.exists(path),
    stat: async (path) => vfs.stat(path),
    rename: async (from, to) => { vfs.rename(from, to); },
  };
};

interface TfsFsPromises {
  readFile(file: string, type?: string): Promise<unknown>;
  writeFile(file: string, content: string, type?: string): Promise<void>;
  readdir(dir: string, opts?: { recursive?: boolean }): Promise<string[]>;
  mkdir(dir: string): Promise<void>;
  rmdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean } | null>;
  rename(oldPath: string, newPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

interface TfsInstance { fs: { promises: TfsFsPromises } }

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
  return {
    readFile: async (path) => String(await p.readFile(path, 'utf8')),
    writeFile: async (path, data) => { await ensureParents(path); await p.writeFile(path, data, 'utf8'); },
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
  };
};
