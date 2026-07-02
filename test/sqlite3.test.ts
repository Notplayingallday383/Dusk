// /bin/sqlite3 — SQLite CLI backed by sql.js on the host.
//
// Tests exercise the CLI + host bridge end-to-end: spawn /bin/sqlite3 in the
// DuskJS engine, send SQL via argv or stdin, verify output. Persistence
// tests round-trip through TFS.

import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const decode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

test('sqlite3 :memory: SELECT 1 → prints 1', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/sqlite3', [':memory:', 'SELECT 1'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('1');
  repl.engine.terminate();
}, 60_000);

test('sqlite3 -header prints column headers', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/sqlite3', ['-header', ':memory:', "SELECT 1 AS a, 'hi' AS b"], { cwd: '/' });
  expect(r.status).toBe(0);
  const lines = decode(r.stdout).trim().split('\n');
  expect(lines[0]).toBe('a|b');
  expect(lines[1]).toBe('1|hi');
  repl.engine.terminate();
}, 60_000);

test('sqlite3 -json produces JSON output', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/sqlite3', ['-json', ':memory:', "SELECT 42 AS x, 'hello' AS y"], { cwd: '/' });
  expect(r.status).toBe(0);
  const parsed = JSON.parse(decode(r.stdout));
  expect(parsed).toEqual([{ x: 42, y: 'hello' }]);
  repl.engine.terminate();
}, 60_000);

test('sqlite3 CREATE/INSERT/SELECT round-trip via inline SQL', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const script = "CREATE TABLE t(id INTEGER, name TEXT); "
    + "INSERT INTO t VALUES (1, 'alice'), (2, 'bob'); "
    + "SELECT COUNT(*) FROM t";
  const r = await repl.processManager.spawnSync(
    '/bin/sqlite3', [':memory:', script], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('2');
  repl.engine.terminate();
}, 60_000);

test('sqlite3 persists a DB to TFS and reads it back across invocations', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // First run: create + insert. Flush on close writes to TFS.
  const create = await repl.processManager.spawnSync(
    '/bin/sqlite3', ['/tmp/test.db',
      "CREATE TABLE users(name TEXT); INSERT INTO users VALUES ('dusk'); INSERT INTO users VALUES ('shell');"],
    { cwd: '/' });
  expect(create.status).toBe(0);

  // Second run: read from the same TFS path.
  const read = await repl.processManager.spawnSync(
    '/bin/sqlite3', ['/tmp/test.db', 'SELECT name FROM users ORDER BY name'], { cwd: '/' });
  expect(read.status).toBe(0);
  const lines = decode(read.stdout).trim().split('\n');
  expect(lines).toEqual(['dusk', 'shell']);
  repl.engine.terminate();
}, 60_000);

test('sqlite3 reads SQL from stdin (pipe mode)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/sqlite3', [':memory:'], {
      cwd: '/',
      stdin: new TextEncoder().encode("SELECT 'from-stdin'"),
    });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('from-stdin');
  repl.engine.terminate();
}, 60_000);

test('sqlite3 error path: syntax error prints to stderr, exit 1', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/sqlite3', [':memory:', 'NOT VALID SQL'], { cwd: '/' });
  expect(r.status).toBe(1);
  expect(decode(r.stderr)).toContain('Error');
  repl.engine.terminate();
}, 60_000);

// dsh has sqlite3 as a built-in custom command that shells out to the same
// host sql.js bridge. Same public CLI as /bin/sqlite3 except no REPL mode.
test('sqlite3 from dsh: dsh runs sqlite3 as a built-in', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', 'sqlite3 :memory: "SELECT 2 + 2"'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('4');
  repl.engine.terminate();
}, 60_000);

test('sqlite3 from dsh: SQL via stdin pipe', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', "echo 'SELECT 5 * 6' | sqlite3 :memory:"], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('30');
  repl.engine.terminate();
}, 60_000);

test('sqlite3 from dsh: persisted DB via TFS round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // Create + insert via dsh
  const w = await repl.processManager.spawnSync('/bin/dsh',
    ['-c', 'sqlite3 /tmp/dsh-db.sqlite "CREATE TABLE t(v INT); INSERT INTO t VALUES (1),(2),(3);"'],
    { cwd: '/' });
  expect(w.status).toBe(0);
  // Read via another dsh invocation (proves TFS persistence)
  const r = await repl.processManager.spawnSync('/bin/dsh',
    ['-c', 'sqlite3 /tmp/dsh-db.sqlite "SELECT SUM(v) FROM t"'],
    { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('6');
  repl.engine.terminate();
}, 60_000);
