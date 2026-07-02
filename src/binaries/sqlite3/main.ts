// /bin/sqlite3 — SQLite CLI backed by sql.js on the host.
//
// Usage:
//   sqlite3 [DBFILE]                        interactive REPL
//   sqlite3 DBFILE "SQL;"                   run one query and exit
//   sqlite3 :memory: "SELECT 1"             in-memory DB
//   echo "SQL;" | sqlite3 DBFILE            script from stdin
//
// The heavy lifting (sql.js WASM) runs on the host and is exposed to the
// engine via four IPC funcs: sqlite.open, sqlite.exec, sqlite.flush,
// sqlite.close (see src/host/sqlite.ts). This binary is a thin CLI wrapper.
//
// Persistence: DBFILE is a path in TFS. Reads and writes go through TFS,
// so a DB created here survives across invocations and is visible to other
// binaries.

type ProcessGlobal = {
  argv: string[];
  env: Record<string, string>;
  cwd: () => string;
  exit?: (n: number) => void;
  stdin?: { read: () => Uint8Array | null };
  stdout: { write: (d: string | Uint8Array) => unknown };
  stderr: { write: (d: string | Uint8Array) => unknown };
};

const getProc = (): ProcessGlobal | undefined =>
  (globalThis as Record<string, unknown>)['process'] as ProcessGlobal | undefined;

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('ipc unavailable');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

// Read all of stdin synchronously (blocking-poll). Used for piped SQL:
//   echo "SELECT 1;" | sqlite3 db.sqlite
const readStdinAll = (): string => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) return '';
  let s = '';
  for (let iter = 0; iter < 100000; iter++) {
    const r = ipc.send({ f: 'proc.readStdin' });
    const v = r.value;
    if (v === null || v === undefined) break;
    if (!Array.isArray(v)) break;
    if (v.length === 0) {
      // Poll gap. Since engine timers are fake, don't loop forever —
      // one empty poll after we already have data means EOF.
      if (s.length > 0) break;
      // No data yet and nothing buffered → assume no stdin was piped.
      break;
    }
    for (let i = 0; i < v.length; i++) s += String.fromCharCode(v[i]);
  }
  return s;
};

// Format one result set like the sqlite3 CLI's default 'list' mode
// (pipe-delimited, one row per line, no headers unless -header set).
type Cell = string | number | boolean | null | { __blob: true; bytes: number[] };
type ResultSet = { columns: string[]; values: Cell[][] };

const cellToString = (v: Cell): string => {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object' && (v as { __blob?: boolean }).__blob) {
    const bytes = (v as { bytes: number[] }).bytes;
    // BLOBs print as X'hexhex...' in sqlite's default mode.
    let hex = '';
    for (const b of bytes) hex += (b < 16 ? '0' : '') + b.toString(16);
    return "X'" + hex + "'";
  }
  return String(v);
};

const formatList = (rs: ResultSet, showHeaders: boolean, separator: string): string => {
  const out: string[] = [];
  if (showHeaders && rs.columns.length > 0) out.push(rs.columns.join(separator));
  for (const row of rs.values) out.push(row.map(cellToString).join(separator));
  return out.join('\n') + (out.length > 0 ? '\n' : '');
};

// Column-aligned mode (-column). Widths are max(cell,header) per column,
// capped at 40 to prevent runaway wide blobs.
const formatColumn = (rs: ResultSet, showHeaders: boolean): string => {
  const widths = rs.columns.map((c) => c.length);
  for (const row of rs.values) {
    for (let i = 0; i < row.length; i++) {
      const w = cellToString(row[i]!).length;
      if (w > (widths[i] ?? 0)) widths[i] = Math.min(w, 40);
    }
  }
  const pad = (s: string, w: number): string => s.length >= w ? s : s + ' '.repeat(w - s.length);
  const lines: string[] = [];
  if (showHeaders) {
    lines.push(rs.columns.map((c, i) => pad(c, widths[i] ?? 0)).join('  '));
    lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  }
  for (const row of rs.values) {
    lines.push(row.map((c, i) => pad(cellToString(c), widths[i] ?? 0)).join('  '));
  }
  return lines.join('\n') + (lines.length > 0 ? '\n' : '');
};

// JSON output (-json).
const formatJson = (rs: ResultSet): string => {
  const objs = rs.values.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < rs.columns.length; i++) {
      const c = rs.columns[i]!;
      const v = row[i];
      obj[c] = v && typeof v === 'object' && (v as { __blob?: boolean }).__blob
        ? '<blob>' : v;
    }
    return obj;
  });
  return JSON.stringify(objs) + '\n';
};

type Mode = 'list' | 'column' | 'json';

const formatRows = (rows: ResultSet[], mode: Mode, showHeaders: boolean, separator: string): string => {
  let out = '';
  for (const rs of rows) {
    if (mode === 'json') out += formatJson(rs);
    else if (mode === 'column') out += formatColumn(rs, showHeaders);
    else out += formatList(rs, showHeaders, separator);
  }
  return out;
};

const runOne = (handle: number, sql: string, mode: Mode, showHeaders: boolean, separator: string,
                stdout: ProcessGlobal['stdout'], stderr: ProcessGlobal['stderr']): number => {
  try {
    const r = call('sqlite.exec', { handle, sql }) as { rows: ResultSet[] };
    const text = formatRows(r.rows, mode, showHeaders, separator);
    if (text) stdout.write(text);
    return 0;
  } catch (e) {
    stderr.write('Error: ' + (e instanceof Error ? e.message : String(e)) + '\n');
    return 1;
  }
};

// Interactive loop: `sqlite>` prompt, semicolon-terminated statements.
// Statements can span lines. Dot-commands (`.help`, `.exit`, `.tables`,
// `.schema`, `.mode`, `.headers`) work as in real sqlite3.
const runInteractive = async (handle: number, dbLabel: string): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) return 1;

  let mode: Mode = 'list';
  let showHeaders = false;
  let separator = '|';

  proc.stdout.write('SQLite (via sql.js) — Dusk edition\n');
  proc.stdout.write('Database: ' + dbLabel + '\n');
  proc.stdout.write('Enter SQL statements terminated with ";" or dot-commands like .help\n');

  const decode = (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!); return s; };
  const readStdin = (): Uint8Array | null => {
    try {
      const r = ipc.send({ f: 'proc.readStdin' });
      if (r.error) return null;
      const v = r.value;
      if (v === null || v === undefined) return null;
      if (Array.isArray(v)) return new Uint8Array(v as number[]);
      return null;
    } catch { return null; }
  };

  let lineBuf = '';
  let stmtBuf = '';

  const readLine = async (): Promise<string | null> => {
    while (true) {
      const nl = lineBuf.indexOf('\n');
      if (nl !== -1) {
        const line = lineBuf.slice(0, nl);
        lineBuf = lineBuf.slice(nl + 1);
        return line;
      }
      const chunk = readStdin();
      if (chunk === null) {
        if (lineBuf.length > 0) { const rest = lineBuf; lineBuf = ''; return rest; }
        return null;
      }
      if (chunk.length === 0) { await new Promise<void>((r) => setTimeout(r, 5)); continue; }
      lineBuf += decode(chunk);
    }
  };

  const handleDot = (line: string): boolean => {
    const parts = line.trim().split(/\s+/);
    const cmd = parts[0]!;
    if (cmd === '.exit' || cmd === '.quit') return true;
    if (cmd === '.help') {
      proc.stdout.write([
        '.exit               Exit sqlite3',
        '.help               Show this help',
        '.tables             List tables',
        '.schema [TABLE]     Show CREATE statements',
        '.mode list|column|json  Change output mode',
        '.headers on|off     Toggle column headers',
        '.separator STR      Set list-mode separator (default "|")',
        '.dump               Dump schema and data as SQL',
        '',
      ].join('\n'));
      return false;
    }
    if (cmd === '.tables') {
      runOne(handle,
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
        'list', false, '|', proc.stdout, proc.stderr);
      return false;
    }
    if (cmd === '.schema') {
      const table = parts[1];
      const sql = table
        ? `SELECT sql FROM sqlite_master WHERE type='table' AND name='${table.replace(/'/g, "''")}'`
        : "SELECT sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL";
      runOne(handle, sql, 'list', false, '|', proc.stdout, proc.stderr);
      return false;
    }
    if (cmd === '.mode' && parts[1]) {
      const m = parts[1] as Mode;
      if (m === 'list' || m === 'column' || m === 'json') mode = m;
      else proc.stderr.write('unknown mode: ' + parts[1] + '\n');
      return false;
    }
    if (cmd === '.headers' && parts[1]) {
      showHeaders = parts[1] === 'on';
      return false;
    }
    if (cmd === '.separator' && parts[1]) {
      separator = parts[1];
      return false;
    }
    proc.stderr.write('unknown dot-command: ' + cmd + ' (try .help)\n');
    return false;
  };

  while (true) {
    proc.stdout.write(stmtBuf.length === 0 ? 'sqlite> ' : '   ...> ');
    const line = await readLine();
    if (line === null) break;

    // Dot commands only at statement boundary and only if the buffer is empty.
    if (stmtBuf.length === 0 && line.trim().startsWith('.')) {
      if (handleDot(line)) break;
      continue;
    }

    stmtBuf += (stmtBuf.length === 0 ? '' : '\n') + line;
    // Very simple statement boundary detection — trailing `;` outside a
    // quoted string. This is imperfect (won't handle `;` inside triggers)
    // but matches sqlite3's default REPL behavior for typical CLI use.
    const trimmed = stmtBuf.trimEnd();
    if (trimmed.endsWith(';')) {
      runOne(handle, stmtBuf, mode, showHeaders, separator, proc.stdout, proc.stderr);
      stmtBuf = '';
    }
  }
  // Flush any leftover statement (no trailing ;).
  if (stmtBuf.trim().length > 0) runOne(handle, stmtBuf, mode, showHeaders, separator, proc.stdout, proc.stderr);
  return 0;
};

export const main = async (): Promise<number> => {
  const proc = getProc();
  if (!proc) return 1;

  const argv = proc.argv.slice(1);

  // Parse: [-header|-noheader] [-list|-column|-json] [-separator STR] [DB [SQL]]
  let mode: Mode = 'list';
  let showHeaders = false;
  let separator = '|';
  let dbPath: string | null = null;
  let inlineSql: string | null = null;
  let showHelp = false;
  let showVersion = false;

  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    if (a === '-header') { showHeaders = true; i++; continue; }
    if (a === '-noheader') { showHeaders = false; i++; continue; }
    if (a === '-list') { mode = 'list'; i++; continue; }
    if (a === '-column') { mode = 'column'; i++; continue; }
    if (a === '-json') { mode = 'json'; i++; continue; }
    if (a === '-separator' && i + 1 < argv.length) { separator = argv[i + 1]!; i += 2; continue; }
    if (a === '--help' || a === '-h') { showHelp = true; i++; continue; }
    if (a === '--version') { showVersion = true; i++; continue; }
    if (a.startsWith('-') && a !== '-') {
      proc.stderr.write('sqlite3: unknown option: ' + a + '\n');
      if (proc.exit) proc.exit(1);
      return 1;
    }
    if (dbPath === null) { dbPath = a; i++; continue; }
    if (inlineSql === null) { inlineSql = a; i++; continue; }
    // extra args are appended to inlineSql with spaces (matches sqlite3 CLI)
    inlineSql += ' ' + a;
    i++;
  }

  if (showHelp) {
    proc.stdout.write([
      'sqlite3 — SQLite CLI (backed by sql.js)',
      'Usage: sqlite3 [OPTIONS] [DB [SQL]]',
      '  DB          Path in TFS. Use ":memory:" for an in-memory DB.',
      '              If omitted, opens ":memory:".',
      '  SQL         One-off SQL to execute; if omitted, drops to REPL.',
      'Options:',
      '  -header, -noheader     Include/omit column headers in output',
      '  -list                  Pipe-delimited output (default)',
      '  -column                Column-aligned output',
      '  -json                  JSON array of objects',
      '  -separator STR         List-mode separator (default "|")',
      '  --version              Print version and exit',
      '  --help                 Print this help and exit',
      '',
    ].join('\n'));
    if (proc.exit) proc.exit(0);
    return 0;
  }
  if (showVersion) {
    proc.stdout.write('sqlite3 (Dusk edition, sql.js-backed) 1.0.0\n');
    if (proc.exit) proc.exit(0);
    return 0;
  }

  const path = dbPath ?? ':memory:';
  let handle: number;
  try {
    const r = call('sqlite.open', { path: path === ':memory:' ? undefined : path, create: true }) as { handle: number };
    handle = r.handle;
  } catch (e) {
    proc.stderr.write('sqlite3: open ' + path + ': ' + (e instanceof Error ? e.message : String(e)) + '\n');
    if (proc.exit) proc.exit(1);
    return 1;
  }

  let exitCode = 0;
  try {
    if (inlineSql !== null) {
      exitCode = runOne(handle, inlineSql, mode, showHeaders, separator, proc.stdout, proc.stderr);
    } else {
      // If stdin has content piped, run it as a script; otherwise REPL.
      const piped = readStdinAll();
      if (piped.trim().length > 0) {
        exitCode = runOne(handle, piped, mode, showHeaders, separator, proc.stdout, proc.stderr);
      } else {
        exitCode = await runInteractive(handle, path);
      }
    }
  } finally {
    try { call('sqlite.close', { handle, flush: true }); } catch { /* best-effort */ }
  }

  if (proc.exit) proc.exit(exitCode);
  return exitCode;
};
