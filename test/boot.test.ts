import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';

test('environment is cross-origin isolated', () => {
  expect(crossOriginIsolated).toBe(true);
  expect(typeof SharedArrayBuffer).toBe('function');
});

test('boots SpiderMonkey and runs user JS end-to-end', async () => {
  const seen: unknown[] = [];
  const runner = await createRunner({
    'console.log': (msg, send) => { seen.push((msg as { args: unknown[] }).args[0]); send({}); },
  });
  await runner.run('print(JSON.stringify({ f: "console.log", args: [1 + 1] }))');
  runner.stop();
  expect(seen).toContain(2);
}, 60_000);
