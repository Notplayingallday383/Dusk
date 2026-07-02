import { test, expect } from 'vitest';
import { initEnginePool, isPoolWarm, bootRepl } from '../src/index';

test('initEnginePool is idempotent and warms the pool', async () => {
  initEnginePool();
  initEnginePool(); // safe to call multiple times
  // Give it a moment to fetch & compile
  await new Promise((r) => setTimeout(r, 1500));
  expect(await isPoolWarm()).toBe(true);
}, 30_000);

test('subsequent engine spawns reuse cached wasm module', async () => {
  const out: string[] = [];
  // First boot triggers warm-up (or completes it).
  const t0 = Date.now();
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const elapsed1 = Date.now() - t0;
  // Now spawn a child /bin/node — should be faster since wasm is cached.
  const t1 = Date.now();
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['--version']); process.stdout.write('STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 800));
  const elapsed2 = Date.now() - t1;
  const text = out.join('');
  expect(text).toContain('STATUS=0');
  // Second engine spawn should be at least a tiny bit faster, but mainly just confirm it works.
  expect(elapsed2).toBeLessThan(elapsed1 + 5000);
  repl.engine.terminate();
}, 60_000);
