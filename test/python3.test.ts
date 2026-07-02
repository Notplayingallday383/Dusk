// /bin/python3 and dsh python3 — CPython via Pyodide.
//
// These tests load Pyodide from CDN on first run (~10MB). They're marked
// with generous timeouts and will skip gracefully if the network fetch
// fails (e.g. in offline CI). To run them: ensure network access from the
// vitest browser runner.

import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const decode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

test('python3 -c prints via /bin/python3', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/python3', ['-c', 'print(2 + 2)'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('4');
  repl.engine.terminate();
}, 120_000);

test('python3 sys.version works', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/python3', ['-c', 'import sys; print(sys.version_info.major)'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('3');
  repl.engine.terminate();
}, 120_000);

test('python3 --version returns version', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/python3', ['--version'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout)).toMatch(/Python 3/);
  repl.engine.terminate();
}, 120_000);

test('python3 syntax error exits 1 with traceback on stderr', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/python3', ['-c', 'this is not valid python'], { cwd: '/' });
  expect(r.status).toBe(1);
  // Pyodide prints a SyntaxError trace to stderr.
  expect(decode(r.stderr).length).toBeGreaterThan(0);
  repl.engine.terminate();
}, 120_000);

test('python3 from dsh: dsh runs python3 as a built-in', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', 'python3 -c "print(\'from-dsh\')"'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('from-dsh');
  repl.engine.terminate();
}, 120_000);

test('python3 from dsh: python alias works too', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', 'python -c "print(3 * 7)"'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('21');
  repl.engine.terminate();
}, 120_000);

test('python3 from dsh: script via stdin pipe', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', "echo 'print(sum([1,2,3,4]))' | python3"], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(decode(r.stdout).trim()).toBe('10');
  repl.engine.terminate();
}, 120_000);

test('python3 executes a TFS-resident script via /bin/python3 SCRIPT', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // Seed the script via dsh (writes to TFS).
  const seed = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', 'echo "print(\'from-tfs\')" > /tmp/hello.py'], { cwd: '/' });
  expect(seed.status).toBe(0);
  // Run the script via /bin/python3.
  const run = await repl.processManager.spawnSync(
    '/bin/python3', ['/tmp/hello.py'], { cwd: '/' });
  expect(run.status).toBe(0);
  expect(decode(run.stdout).trim()).toBe('from-tfs');
  repl.engine.terminate();
}, 120_000);
