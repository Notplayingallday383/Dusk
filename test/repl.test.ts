import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { startRepl } from '../src/repl/repl';

test('repl evaluates a line and prints the result', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  const repl = startRepl(runner, (t) => out.push(t));
  await repl.feed('21 * 2\n');
  runner.stop();
  expect(out.join('')).toContain('42');
}, 60_000);
