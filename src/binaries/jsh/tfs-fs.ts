// TfsFs — adapter that implements just-bash's IFileSystem on top of DuskJS's
// TFS (accessed via the __fs IPC bridge). Writes go straight to TFS, so
// changes made inside jsh persist across process invocations and are visible
// to other binaries that read TFS directly.
//
// Coverage
// - Direct passthrough: readFile, writeFile, readdir, mkdir, rm, exists,
//   stat, mv (rename), appendFile.
// - Synthesized: readFileBuffer / readFileBytes (latin1 → Uint8Array),
//   readdirWithFileTypes (readdir+stat), cp recursive (walk+write),
//   lstat (= stat; TFS has no symlinks), realpath (= resolvePath; ditto),
//   getAllPaths (walk from /, capped).
// - No-op: chmod, utimes (TFS has no permissions or mtimes yet).
// - ENOTSUP: symlink, link, readlink.
//
// The strategy prefers "silently degrade" over "hard fail" because typical
// shell workflows call chmod/utimes for side effects we don't model, but
// still expect the surrounding pipeline to keep working.

// @ts-nocheck
import { resolvePath as jbResolvePath } from '../../vendor/just-bash/fs/path-utils';
import { unsafeBytesFromLatin1 } from '../../vendor/just-bash/encoding';

type FsGlobal = {
  readFile: (path: string) => string;
  writeFile: (path: string, data: string) => void;
  readdir: (path: string) => string[];
  mkdir: (path: string, recursive: boolean) => void;
  rm: (path: string, recursive?: boolean) => void;
  exists: (path: string) => boolean;
  stat: (path: string) => { isFile: boolean; isDirectory: boolean; size?: number };
  rename: (from: string, to: string) => void;
  appendFile: (path: string, data: string) => void;
};

const getFs = (): FsGlobal => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as FsGlobal | undefined;
  if (!fs) throw new Error('__fs not available (jsh must run inside a DuskJS world)');
  return fs;
};

// Encode a latin1 string (each char is a byte, 0-255) to Uint8Array.
// DuskJS's fs.readFile returns strings; binary content is preserved
// character-per-byte, matching just-bash's ByteString convention.
const latinToBytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};

// Decode Uint8Array as latin1 for writing back through the string-based IPC.
const bytesToLatin = (u: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < u.length; i++) s += String.fromCharCode(u[i]!);
  return s;
};

const normalizeContent = (content: string | Uint8Array): string => {
  if (typeof content === 'string') return content;
  return bytesToLatin(content);
};

const asString = (content: string | Uint8Array, encoding?: string | null | { encoding?: string | null }): string => {
  const enc = typeof encoding === 'string' ? encoding : encoding?.encoding;
  if (typeof content !== 'string') return bytesToLatin(content);
  // TFS returns strings; treat as-is unless caller asked for binary/latin1.
  return content;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  void enc;
};

export class TfsFs {
  // Ambient TFS root ("/"). Everything is TFS.
  private _statCache = new Map<string, { isFile: boolean; isDirectory: boolean; size?: number }>();

  private fs(): FsGlobal { return getFs(); }

  // --- reads ------------------------------------------------------------
  async readFile(path: string, _options?: unknown): Promise<string> {
    return this.fs().readFile(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return latinToBytes(this.fs().readFile(path));
  }

  async readFileBytes(path: string): Promise<any> {
    // ByteString is a latin1-shaped opaque nominal type; tag the raw TFS
    // string (each char = one byte) via the sanctioned helper.
    return unsafeBytesFromLatin1(this.fs().readFile(path));
  }

  // --- writes -----------------------------------------------------------
  async writeFile(path: string, content: string | Uint8Array, _options?: unknown): Promise<void> {
    this.fs().writeFile(path, normalizeContent(content));
  }

  async appendFile(path: string, content: string | Uint8Array, _options?: unknown): Promise<void> {
    this.fs().appendFile(path, normalizeContent(content));
  }

  // --- metadata / existence --------------------------------------------
  async exists(path: string): Promise<boolean> {
    try { return this.fs().exists(path); } catch { return false; }
  }

  async stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }> {
    const s = this.fs().stat(path);
    return {
      isFile: !!s.isFile,
      isDirectory: !!s.isDirectory,
      isSymbolicLink: false,
      mode: s.isDirectory ? 0o755 : 0o644,
      size: s.size ?? 0,
      mtime: new Date(0),
    };
  }

  // No symlinks in TFS — lstat mirrors stat.
  async lstat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean; mode: number; size: number; mtime: Date }> {
    return this.stat(path);
  }

  // --- directory ops ---------------------------------------------------
  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.fs().mkdir(path, !!options?.recursive);
  }

  async readdir(path: string): Promise<string[]> {
    return this.fs().readdir(path);
  }

  async readdirWithFileTypes(path: string): Promise<Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }>> {
    const names = this.fs().readdir(path);
    const out: Array<{ name: string; isFile: boolean; isDirectory: boolean; isSymbolicLink: boolean }> = [];
    for (const name of names) {
      const child = path === '/' ? '/' + name : path + '/' + name;
      let s: { isFile: boolean; isDirectory: boolean } | undefined;
      try { s = this.fs().stat(child); } catch { /* skip */ }
      out.push({
        name,
        isFile: !!s?.isFile,
        isDirectory: !!s?.isDirectory,
        isSymbolicLink: false,
      });
    }
    return out;
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    try {
      this.fs().rm(path, !!options?.recursive);
    } catch (e) {
      if (options?.force) return;
      throw e;
    }
  }

  // --- copy / move -----------------------------------------------------
  async cp(src: string, dest: string, options?: { recursive?: boolean }): Promise<void> {
    const fs = this.fs();
    if (!fs.exists(src)) throw new Error(`cp: no such file or directory: ${src}`);
    const st = fs.stat(src);
    if (st.isDirectory) {
      if (!options?.recursive) throw new Error(`cp: -r not specified; omitting directory '${src}'`);
      fs.mkdir(dest, true);
      const entries = fs.readdir(src);
      for (const name of entries) {
        const s = src === '/' ? '/' + name : src + '/' + name;
        const d = dest === '/' ? '/' + name : dest + '/' + name;
        await this.cp(s, d, options);
      }
    } else {
      fs.writeFile(dest, fs.readFile(src));
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    this.fs().rename(src, dest);
  }

  // --- path arithmetic (pure, no IPC) ---------------------------------
  resolvePath(base: string, path: string): string {
    return jbResolvePath(base, path);
  }

  async realpath(path: string): Promise<string> {
    // No symlinks: canonical path == resolved path. Enforce existence.
    const resolved = jbResolvePath('/', path);
    if (!this.fs().exists(resolved)) throw new Error(`realpath: ${path}: No such file or directory`);
    return resolved;
  }

  // --- attributes (no-op for TFS; commands often set these for effect) --
  async chmod(_path: string, _mode: number): Promise<void> { /* TFS has no permissions */ }
  async utimes(_path: string, _atime: Date, _mtime: Date): Promise<void> { /* TFS has no mtimes */ }

  // --- symlinks / hardlinks (unsupported) ------------------------------
  async symlink(_target: string, _linkPath: string): Promise<void> {
    throw new Error('ENOTSUP: TFS does not support symlinks');
  }
  async link(_existingPath: string, _newPath: string): Promise<void> {
    throw new Error('ENOTSUP: TFS does not support hard links');
  }
  async readlink(_path: string): Promise<string> {
    throw new Error('EINVAL: not a symlink');
  }

  // --- glob support: enumerate reachable paths, capped ------------------
  // just-bash calls this to power glob expansion when it can't stat
  // candidates one by one. We do a bounded walk of the whole TFS tree.
  private _pathsCache: string[] | null = null;
  private _pathsCacheAt = 0;
  getAllPaths(): string[] {
    // Cache for 100ms to keep glob-heavy scripts fast; TFS reads still hit IPC.
    const now = Date.now();
    if (this._pathsCache && (now - this._pathsCacheAt) < 100) return this._pathsCache;
    const fs = this.fs();
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (p: string, depth: number): void => {
      if (depth > 12 || out.length >= 8192 || seen.has(p)) return;
      seen.add(p);
      out.push(p);
      let entries: string[] = [];
      try { entries = fs.readdir(p); } catch { return; }
      for (const name of entries) {
        const child = p === '/' ? '/' + name : p + '/' + name;
        let s: { isFile: boolean; isDirectory: boolean } | undefined;
        try { s = fs.stat(child); } catch { continue; }
        if (!s) continue;
        if (s.isDirectory) walk(child, depth + 1);
        else out.push(child);
        if (out.length >= 8192) return;
      }
    };
    try { walk('/', 0); } catch { /* */ }
    this._pathsCache = out;
    this._pathsCacheAt = now;
    return out;
  }
}
