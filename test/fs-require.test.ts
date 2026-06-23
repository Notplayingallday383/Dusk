import { test, expect } from 'vitest';
import { createVFS } from '../src/host/vfs';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createRunner } from '../src/host/runner';
import { createFuncs } from '../src/host/funcs';

test('vfs round-trips files and dirs', () => {
  const vfs = createVFS();
  vfs.mkdir('/app', { recursive: true });
  vfs.writeFile('/app/a.txt', 'hello');
  expect(vfs.readFile('/app/a.txt')).toBe('hello');
  expect(vfs.readdir('/app')).toEqual(['a.txt']);
  expect(vfs.exists('/app/a.txt')).toBe(true);
  vfs.rm('/app/a.txt');
  expect(vfs.exists('/app/a.txt')).toBe(false);
});

test('require loads a module from the VFS', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/dep.js', 'module.exports = 40 + 2;');
  await backend.writeFile('/main.js', 'console.log(require("./dep.js"));');
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  await runner.run(await backend.readFile('/main.js'));
  runner.stop();
  expect(out.join('')).toContain('42');
}, 60_000);
