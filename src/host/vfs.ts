export interface VFS {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  readFileBytes(path: string): Uint8Array;
  writeFileBytes(path: string, data: Uint8Array): void;
  fileSize(path: string): number;
  readdir(path: string): string[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  rm(path: string): void;
  exists(path: string): boolean;
  stat(path: string): { isFile: boolean; isDirectory: boolean };
  rename(from: string, to: string): void;
  symlink(target: string, path: string): void;
  readlink(path: string): string;
  lstat(path: string): { isFile: boolean; isDirectory: boolean; isSymlink: boolean };
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

const encodeUtf8 = (s: string): Uint8Array => {
  // Hand-rolled to match project convention (no TextEncoder in world; host can use it,
  // but for parity and to avoid surprises we hand-roll here too).
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length) {
      const c2 = s.charCodeAt(i + 1);
      if (c2 >= 0xDC00 && c2 <= 0xDFFF) { c = 0x10000 + (((c - 0xD800) << 10) | (c2 - 0xDC00)); i++; }
    }
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xC0 | (c >> 6), 0x80 | (c & 0x3F));
    else if (c < 0x10000) out.push(0xE0 | (c >> 12), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
    else out.push(0xF0 | (c >> 18), 0x80 | ((c >> 12) & 0x3F), 0x80 | ((c >> 6) & 0x3F), 0x80 | (c & 0x3F));
  }
  return Uint8Array.from(out);
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]!;
    if (b < 0x80) { s += String.fromCharCode(b); i++; }
    else if (b < 0xE0) { s += String.fromCharCode(((b & 0x1F) << 6) | (bytes[i + 1]! & 0x3F)); i += 2; }
    else if (b < 0xF0) { s += String.fromCharCode(((b & 0x0F) << 12) | ((bytes[i + 1]! & 0x3F) << 6) | (bytes[i + 2]! & 0x3F)); i += 3; }
    else {
      const cp = ((b & 0x07) << 18) | ((bytes[i + 1]! & 0x3F) << 12) | ((bytes[i + 2]! & 0x3F) << 6) | (bytes[i + 3]! & 0x3F);
      const off = cp - 0x10000;
      s += String.fromCharCode(0xD800 + (off >> 10), 0xDC00 + (off & 0x3FF));
      i += 4;
    }
  }
  return s;
};

export const createVFS = (): VFS => {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(['/']);
  const symlinks = new Map<string, string>();  // path → target

  const ensureDir = (d: string): void => {
    if (d === '/' || dirs.has(d)) return;
    throw new Error('ENOENT: no such directory ' + d);
  };

  const resolveSymlinks = (path: string, depth = 0): string => {
    if (depth > 32) throw new Error('ELOOP: too many symbolic links: ' + path);
    const n = norm(path);
    const target = symlinks.get(n);
    if (target === undefined) return n;
    const resolved = target.startsWith('/') ? target : norm(n.split('/').slice(0, -1).join('/') + '/' + target);
    return resolveSymlinks(resolved, depth + 1);
  };

  return {
    readFile(path) {
      const resolved = resolveSymlinks(path);
      const f = files.get(resolved);
      if (f === undefined) throw new Error('ENOENT: no such file ' + resolved);
      return decodeUtf8(f);
    },
    writeFile(path, data) {
      const n = norm(path);
      ensureDir(dirname(n));
      files.set(n, encodeUtf8(data));
    },
    readFileBytes(path) {
      const resolved = resolveSymlinks(path);
      const f = files.get(resolved);
      if (f === undefined) throw new Error('ENOENT: no such file ' + resolved);
      // Return a fresh copy so callers can't mutate stored bytes.
      return f.slice();
    },
    writeFileBytes(path, data) {
      const n = norm(path);
      ensureDir(dirname(n));
      files.set(n, data.slice());
    },
    fileSize(path) {
      const resolved = resolveSymlinks(path);
      const f = files.get(resolved);
      if (f === undefined) throw new Error('ENOENT: no such file ' + resolved);
      return f.length;
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
    symlink(target, path) {
      const n = norm(path);
      symlinks.set(n, target);
    },
    readlink(path) {
      const n = norm(path);
      const t = symlinks.get(n);
      if (t === undefined) throw new Error('EINVAL: ' + n + ' is not a symlink');
      return t;
    },
    lstat(path) {
      const n = norm(path);
      if (symlinks.has(n)) return { isFile: false, isDirectory: false, isSymlink: true };
      if (files.has(n)) return { isFile: true, isDirectory: false, isSymlink: false };
      if (dirs.has(n)) return { isFile: false, isDirectory: true, isSymlink: false };
      throw new Error('ENOENT: ' + n);
    },
  };
};

export { norm, dirname, basename, encodeUtf8, decodeUtf8 };
