export interface VFS {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  readdir(path: string): string[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  rm(path: string): void;
  exists(path: string): boolean;
  stat(path: string): { isFile: boolean; isDirectory: boolean };
  rename(from: string, to: string): void;
}

const norm = (p: string): string => {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
};

const dirname = (p: string): string => norm(p).split('/').slice(0, -1).join('/') || '/';
const basename = (p: string): string => norm(p).split('/').pop() ?? '';

export const createVFS = (): VFS => {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/']);

  const ensureDir = (d: string): void => {
    if (d === '/' || dirs.has(d)) return;
    throw new Error('ENOENT: no such directory ' + d);
  };

  return {
    readFile(path) {
      const n = norm(path);
      const f = files.get(n);
      if (f === undefined) throw new Error('ENOENT: no such file ' + n);
      return f;
    },
    writeFile(path, data) {
      const n = norm(path);
      ensureDir(dirname(n));
      files.set(n, data);
    },
    readdir(path) {
      const n = norm(path);
      if (!dirs.has(n) && n !== '/') throw new Error('ENOTDIR: ' + n);
      const prefix = n === '/' ? '/' : n + '/';
      const out = new Set<string>();
      for (const f of files.keys()) if (f.startsWith(prefix)) out.add(f.slice(prefix.length).split('/')[0]!);
      for (const d of dirs) if (d !== n && d.startsWith(prefix)) out.add(d.slice(prefix.length).split('/')[0]!);
      return [...out];
    },
    mkdir(path, opts) {
      const n = norm(path);
      if (opts?.recursive) {
        const segs = n.split('/').filter(Boolean);
        let cur = '';
        for (const s of segs) { cur += '/' + s; dirs.add(cur); }
      } else {
        ensureDir(dirname(n));
        dirs.add(n);
      }
    },
    rm(path) {
      const n = norm(path);
      files.delete(n);
      dirs.delete(n);
      for (const f of [...files.keys()]) if (f.startsWith(n + '/')) files.delete(f);
      for (const d of [...dirs]) if (d.startsWith(n + '/')) dirs.delete(d);
    },
    exists(path) {
      const n = norm(path);
      return files.has(n) || dirs.has(n);
    },
    stat(path) {
      const n = norm(path);
      if (files.has(n)) return { isFile: true, isDirectory: false };
      if (dirs.has(n)) return { isFile: false, isDirectory: true };
      throw new Error('ENOENT: ' + n);
    },
    rename(from, to) {
      const nf = norm(from), nt = norm(to);
      const f = files.get(nf);
      if (f === undefined) throw new Error('ENOENT: ' + nf);
      files.delete(nf);
      files.set(nt, f);
    },
  };
};

export { norm, dirname, basename };
