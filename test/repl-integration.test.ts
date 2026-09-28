import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('bootRepl exposes ProcessManager and EngineInstance', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  expect(repl.processManager).toBeDefined();
  expect(repl.engine).toBeDefined();
  expect(repl.engine.pid).toBe(0);
  expect(typeof repl.feed).toBe('function');
  repl.engine.terminate();
}, 60_000);

test('bootRepl REPL can spawn /bin/sh -c "echo hello" via require(child_process)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const cp = require('child_process'); const r = cp.spawnSync('/bin/sh', ['-c', 'echo hello']); process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));\n");
  repl.engine.terminate();
  const text = out.join('');
  expect(text).toContain('status=0');
  expect(text).toContain('hello');
}, 60_000);

test('bootRepl REPL can spawn /bin/echo directly via require(child_process)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const cp = require('child_process'); const r = cp.spawnSync('/bin/echo', ['hi']); process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));\n");
  repl.engine.terminate();
  const text = out.join('');
  expect(text).toContain('status=0');
  expect(text).toContain('hi');
}, 60_000);

test('bootRepl REPL completes nested guest spawnSync before SIGCHLD dispatch', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  repl.processManager.registerBinary('/bin/nested-spawn-sync', `
    const cp = require('node:child_process');
    const result = cp.spawnSync('/bin/sh', ['-c', 'echo nested-guest']);
    process.stdout.write('inner=' + result.status + ':' + new TextDecoder().decode(result.stdout));
    process.exit(result.status);
  `);

  await repl.feed(`
    const cp = require('node:child_process');
    let releaseSigchld;
    const sigchld = new Promise((resolve) => { releaseSigchld = resolve; });
    process.on('SIGCHLD', () => releaseSigchld());
    const result = cp.spawnSync('/bin/nested-spawn-sync', []);
    await sigchld;
    process.stdout.write('outer=' + result.status + ':' + new TextDecoder().decode(result.stdout));
  `);
  await repl.engine.terminate();

  const text = out.join('');
  expect(text).toContain('outer=0:inner=0:nested-guest');
}, 15_000);

test('bootRepl ProcessManager has /bin/sh and builtin binaries registered', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync('/bin/sh', ['-c', 'echo from-pm'], { cwd: '/' });
  expect(r.status).toBe(0);
  expect(new TextDecoder().decode(r.stdout)).toBe('from-pm\n');
  const r2 = await repl.processManager.spawnSync('/bin/echo', ['ok'], { cwd: '/' });
  expect(r2.status).toBe(0);
  expect(new TextDecoder().decode(r2.stdout)).toBe('ok\n');
  repl.engine.terminate();
}, 60_000);
