// Host-side SQLite bridge for /bin/sqlite3.
//
// Loads sql.js (WASM) lazily on first use. Databases are opened by TFS path:
// the file is read, passed to sql.js as a byte buffer, mutated in memory,
// and (on close/flush) written back to TFS. This mirrors sqlite's real
// file-based behavior but through TFS instead of the local filesystem.
//
// Concurrency: each open() returns a numeric handle. Handles are per-page,
// not per-process, so two /bin/sqlite3 invocations targeting the same DB
// path each get their own in-memory copy. The last one to close wins.
// Good enough for the demo/shell use case; a real workload would want
// a lock or a single-writer discipline.

import type { FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';

// sql.js's TypeScript types describe Database/Statement; we hold the module
// itself as opaque here since we import lazily and don't want to load its
// type surface into every file.
type SqlJsDatabase = {
  exec: (sql: string) => Array<{ columns: string[]; values: unknown[][] }>;
  run: (sql: string, params?: unknown[]) => void;
  export: () => Uint8Array;
  close: () => void;
};
type SqlJsModule = {
  Database: new (data?: Uint8Array) => SqlJsDatabase;
};

let sqlJsPromise: Promise<SqlJsModule> | undefined;

// Lazy-load sql.js. Vite's ?url import gives us the correct served URL for
// the .wasm asset at both dev and build time (it's hashed into the output
// dir at build). Node/vitest test environments serve node_modules assets
// via the same import.meta.url resolution, so this works there too.
const loadSqlJs = async (): Promise<SqlJsModule> => {
  if (!sqlJsPromise) {
    sqlJsPromise = (async (): Promise<SqlJsModule> => {
      // Dynamic import splits sql.js's ~150KB JS glue + ~1.5MB WASM into
      // its own chunk that's only fetched when a DB is opened.
      const initSqlJs = (await import('sql.js')).default as unknown as (
        opts?: { locateFile?: (f: string) => string },
      ) => Promise<SqlJsModule>;
      // ?url gets vite to resolve + serve the file at a stable URL.
      const wasmUrl = (await import('sql.js/dist/sql-wasm.wasm?url')).default;
      return await initSqlJs({
        locateFile: (file: string) => {
          if (file.endsWith('.wasm')) return wasmUrl;
          return file;
        },
      });
    })();
  }
  return sqlJsPromise;
};

// Per-handle state — the db, its TFS-source path, whether it's mutated.
type Handle = {
  db: SqlJsDatabase;
  path: string | null;   // null = :memory:
  dirty: boolean;
};

const handles = new Map<number, Handle>();
let nextHandle = 1;

const ok = (send: (m: unknown) => void, value: unknown): void => { send({ value }); };
const err = (send: (m: unknown) => void, e: unknown): void => {
  send({ error: e instanceof Error ? e.message : String(e) });
};

export const createSqliteFuncs = (fs: FSBackend): FuncTable => ({
  // sqlite.open { path?: string, create?: boolean } → { handle: number }
  //   path === undefined or ":memory:" → in-memory DB
  //   path present + exists → load bytes from TFS
  //   path present + missing + create truthy → new DB, will write back on close
  'sqlite.open': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const SQL = await loadSqlJs();
        const path = (m['path'] as string | undefined) ?? null;
        const create = !!m['create'];
        let bytes: Uint8Array | undefined;
        let effectivePath: string | null = path;
        if (path && path !== ':memory:') {
          if (await fs.exists(path)) {
            const raw = await fs.readFile(path);
            bytes = new Uint8Array(raw.length);
            for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i) & 0xff;
          } else if (!create) {
            err(send, new Error('no such file: ' + path));
            return;
          }
        } else {
          effectivePath = null;
        }
        const db = new SQL.Database(bytes);
        const id = nextHandle++;
        handles.set(id, { db, path: effectivePath, dirty: false });
        ok(send, { handle: id });
      } catch (e) { err(send, e); }
    })();
  },

  // sqlite.exec { handle: number, sql: string } → { rows: [{columns,values}], dirty }
  // Runs one or more SQL statements. Returns all resultsets in order.
  // Sets dirty=true internally if the SQL is a write; caller receives it in the reply.
  'sqlite.exec': (m, send): void => {
    try {
      const id = m['handle'] as number;
      const sql = m['sql'] as string;
      const h = handles.get(id);
      if (!h) { err(send, new Error('bad handle: ' + id)); return; }
      const rows = h.db.exec(sql);
      // Serialize typed values (bigints, uint8array, etc.) to something the
      // JSON channel can carry. Numbers/strings/nulls pass through.
      const serialized = rows.map((r) => ({
        columns: r.columns,
        values: r.values.map((row) => row.map((v) => {
          if (v === null || v === undefined) return null;
          if (typeof v === 'bigint') return String(v);
          if (v instanceof Uint8Array) {
            return { __blob: true, bytes: Array.from(v) };
          }
          return v;
        })),
      }));
      // Heuristic: assume any statement that isn't purely SELECT/PRAGMA is a write.
      // sql.js's exec doesn't tell us. This is a coarse dirty marker.
      const writeLikely = /^\s*(?:INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|REPLACE|VACUUM|WITH|BEGIN|COMMIT|ROLLBACK)/i.test(sql);
      if (writeLikely) h.dirty = true;
      ok(send, { rows: serialized, dirty: h.dirty });
    } catch (e) { err(send, e); }
  },

  // sqlite.flush { handle: number } → { path, bytes: number }
  // Writes the current in-memory DB back to TFS. Only if handle has a path.
  'sqlite.flush': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const id = m['handle'] as number;
        const h = handles.get(id);
        if (!h) { err(send, new Error('bad handle: ' + id)); return; }
        if (!h.path) { ok(send, { path: null, bytes: 0 }); return; }
        const bytes = h.db.export();
        // TFS's writeFile takes strings. Encode as latin1 (byte-preserving).
        let s = '';
        for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
        await fs.writeFile(h.path, s);
        h.dirty = false;
        ok(send, { path: h.path, bytes: bytes.length });
      } catch (e) { err(send, e); }
    })();
  },

  // sqlite.close { handle: number, flush?: boolean } → { flushed: boolean }
  'sqlite.close': (m, send): void => {
    void (async (): Promise<void> => {
      try {
        const id = m['handle'] as number;
        const h = handles.get(id);
        if (!h) { err(send, new Error('bad handle: ' + id)); return; }
        let flushed = false;
        if (h.path && (m['flush'] !== false) && h.dirty) {
          const bytes = h.db.export();
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
          await fs.writeFile(h.path, s);
          flushed = true;
        }
        h.db.close();
        handles.delete(id);
        ok(send, { flushed });
      } catch (e) { err(send, e); }
    })();
  },
});
