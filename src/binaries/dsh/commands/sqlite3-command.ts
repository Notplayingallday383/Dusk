// dsh custom command: sqlite3
//
// A just-bash-registered command that shells out to the DuskJS host's
// sqlite bridge (see src/host/sqlite.ts). Same public CLI as /bin/sqlite3
// but usable from within dsh scripts: `dsh -c 'sqlite3 /tmp/db "SELECT 1"'`.
//
// Interactive REPL mode is NOT supported here — inside dsh, sqlite3 always
// runs in one-shot mode (SQL via argv or stdin, formatted output, exit).
// For a REPL, invoke /bin/sqlite3 directly.
//
// This is the just-bash side; the actual work happens on the DuskJS host
// via the sqlite.open / sqlite.exec / sqlite.close IPC funcs.

// @ts-nocheck
import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, args: Record<string, unknown> = {}): unknown => {
  const ipc = (globalThis as { ipc?: Ipc }).ipc;
  if (!ipc) throw new Error('sqlite3: ipc unavailable in this context');
  const r = ipc.send({ f, ...args });
  if (r.error) throw new Error(r.error);
  return r.value;
};

type Cell = string | number | boolean | null | { __blob: true; bytes: number[] };
type ResultSet = { columns: string[]; values: Cell[][] };
type Mode = 'list' | 'column' | 'json';

const cellToString = (v: Cell): string => {
  if (v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v && typeof v === 'object' && (v as { __blob?: boolean }).__blob) {
    const bytes = (v as { bytes: number[] }).bytes;
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

export const sqlite3Command: Command = {
  name: 'sqlite3',
  trusted: true,
  async execute(argv: string[], ctx: CommandContext): Promise<ExecResult> {
    let mode: Mode = 'list';
    let showHeaders = false;
    let separator = '|';
    let dbPath: string | null = null;
    let inlineSql: string | null = null;

    let i = 0;
    while (i < argv.length) {
      const a = argv[i]!;
      if (a === '-header') { showHeaders = true; i++; continue; }
      if (a === '-noheader') { showHeaders = false; i++; continue; }
      if (a === '-list') { mode = 'list'; i++; continue; }
      if (a === '-column') { mode = 'column'; i++; continue; }
      if (a === '-json') { mode = 'json'; i++; continue; }
      if (a === '-separator' && i + 1 < argv.length) { separator = argv[i + 1]!; i += 2; continue; }
      if (a === '--version') {
        return { stdout: 'sqlite3 (Dusk dsh command, sql.js-backed) 1.0.0\n', stderr: '', exitCode: 0 };
      }
      if (a === '--help' || a === '-h') {
        return {
          stdout: [
            'sqlite3 — dsh built-in wrapping DuskJS sqlite bridge',
            'Usage: sqlite3 [OPTIONS] DB [SQL]',
            '  DB    Path in TFS, or :memory:',
            '  SQL   SQL to run. If omitted, reads from stdin.',
            'Options: -header, -noheader, -list, -column, -json, -separator STR',
            '',
          ].join('\n'),
          stderr: '', exitCode: 0,
        };
      }
      if (a.startsWith('-') && a !== '-') {
        return { stdout: '', stderr: 'sqlite3: unknown option: ' + a + '\n', exitCode: 1 };
      }
      if (dbPath === null) { dbPath = a; i++; continue; }
      if (inlineSql === null) { inlineSql = a; i++; continue; }
      inlineSql += ' ' + a;
      i++;
    }

    const path = dbPath ?? ':memory:';
    const stdinText = typeof ctx.stdin === 'string' ? ctx.stdin : '';
    // If no inline SQL, use stdin. If both empty, error out (no REPL from dsh).
    const sql = inlineSql ?? stdinText;
    if (!sql.trim()) {
      return {
        stdout: '',
        stderr: 'sqlite3: no SQL provided. Use `sqlite3 DB "SQL"` or pipe SQL via stdin.\n' +
                'For interactive REPL, run /bin/sqlite3 directly outside dsh.\n',
        exitCode: 2,
      };
    }

    let handle: number;
    try {
      const r = call('sqlite.open',
        { path: path === ':memory:' ? undefined : path, create: true }) as { handle: number };
      handle = r.handle;
    } catch (e) {
      return { stdout: '', stderr: 'sqlite3: open ' + path + ': ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
    }

    try {
      const r = call('sqlite.exec', { handle, sql }) as { rows: ResultSet[] };
      let text = '';
      for (const rs of r.rows) {
        if (mode === 'json') text += formatJson(rs);
        else if (mode === 'column') text += formatColumn(rs, showHeaders);
        else text += formatList(rs, showHeaders, separator);
      }
      return { stdout: text, stderr: '', exitCode: 0 };
    } catch (e) {
      return { stdout: '', stderr: 'Error: ' + (e instanceof Error ? e.message : String(e)) + '\n', exitCode: 1 };
    } finally {
      try { call('sqlite.close', { handle, flush: true }); } catch { /* */ }
    }
  },
};
