import { test, expect } from 'vitest';
import { createEngine } from '../src/host/engine-instance';

test('createEngine boots SpiderMonkey and runs user JS', async () => {
  const seen: unknown[] = [];
  const engine = await createEngine(0, {
    'console.log': (msg, send) => { seen.push((msg as { args: unknown[] }).args[0]); send({}); },
  });
  await engine.run('print(JSON.stringify({ f: "console.log", args: [1 + 1] }))');
  await engine.terminate();
  expect(seen).toContain(2);
}, 60_000);

test('createEngine terminates with exit code', async () => {
  const engine = await createEngine(1, {});
  await engine.terminate();
  const code = await engine.exited;
  expect(code).toBe(1);
}, 60_000);

test('process.exit terminates the engine with exit code', async () => {
  const engine = await createEngine(1, {
    'process.exit': (_m, send) => { send({}); },
    'proc.write': (_m, send) => { send({}); },
  });
  void engine.run('process.exit(0)');
  const code = await engine.exited;
  expect(code).toBe(0);
}, 60_000);

test('process.pid is set', async () => {
  let pid: unknown;
  const engine = await createEngine(42, {
    'console.log': (msg, send) => { pid = (msg as { args: unknown[] }).args[0]; send({}); },
    'proc.write': (_m, send) => { send({}); },
  });
  await engine.run('print(JSON.stringify({ f: "console.log", args: [process.pid] }))');
  await engine.terminate();
  expect(pid).toBe(42);
}, 60_000);
