import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';

test('import loads an ESM module from the VFS', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/lib.mjs', 'export const answer = 42;');
  await backend.writeFile('/main.mjs', 'const m = await import("./lib.mjs"); console.log(m.answer);');
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  await runner.run(await backend.readFile('/main.mjs'));
  runner.stop();
  expect(out.join('')).toContain('42');
}, 60_000);
