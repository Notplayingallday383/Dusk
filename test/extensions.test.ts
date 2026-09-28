import { expect, test } from 'vitest';
import { bootRepl, createMemoryBackend, loadDuskExtensions } from '../src';
import type { FSBackend } from '../src/host/fs-backend';
import { createSqliteExtension } from '../../extensions/dusk-sqlite/src/host';

const host = { packageName: '@nightnetwork/dusk-sqlite', entry: './src/host.ts', activate: async (_fs: FSBackend) => ({ funcs: {}, binaries: {} }) };

const sqliteManifest = JSON.stringify({
  duskExtension: 1,
  host: {
    entry: './src/host.ts',
    binaries: ['/bin/sqlite3'],
    functions: ['sqlite.open', 'sqlite.exec', 'sqlite.flush', 'sqlite.close'],
  },
});

const install = async (fs: FSBackend, manifest = sqliteManifest, integrity = 'sha512-trusted'): Promise<void> => {
  await fs.mkdir('/project/node_modules/@nightnetwork/dusk-sqlite', { recursive: true });
  await fs.writeFile('/project/node_modules/@nightnetwork/dusk-sqlite/package.json', JSON.stringify({
    name: '@nightnetwork/dusk-sqlite', version: '1.0.0',
  }));
  await fs.writeFile('/project/node_modules/@nightnetwork/dusk-sqlite/dusk.extension', manifest);
  await fs.writeFile('/project/package-lock.json', JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/@nightnetwork/dusk-sqlite': {
        version: '1.0.0', resolved: 'https://registry.dusk.night-x.com/@nightnetwork/dusk-sqlite/-/dusk-sqlite-1.0.0.tgz', integrity,
      },
    },
  }));
};

test('base Dusk exposes neither sqlite IPC nor the sqlite3 binary', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  expect(repl.processManager.listBinaries()).not.toContain('/bin/sqlite3');
  const result = await repl.processManager.spawnSync('/bin/sqlite3', [':memory:', 'SELECT 1'], { cwd: '/' });
  expect(result.status).not.toBe(0);
  await repl.engine.terminate();
});

test('extension loader rejects malformed manifests before host code is considered', async () => {
  const fs = createMemoryBackend();
  await install(fs, '{"duskExtension":2}');
  await expect(loadDuskExtensions(fs, '/project', [host])).rejects.toThrow('unsupported dusk extension manifest');
});

test('extension loader rejects a package whose lock entry is not registry trusted', async () => {
  const fs = createMemoryBackend();
  await install(fs, sqliteManifest, '');
  await expect(loadDuskExtensions(fs, '/project', [host])).rejects.toThrow('trusted lockfile integrity');
});

test('a lockfile-authorized sqlite extension activates after restart and persists TFS databases', async () => {
  const seed = {
    '/project/node_modules/@nightnetwork/dusk-sqlite/package.json': JSON.stringify({ name: '@nightnetwork/dusk-sqlite', version: '1.0.0' }),
    '/project/node_modules/@nightnetwork/dusk-sqlite/dusk.extension': sqliteManifest,
    '/project/package-lock.json': JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/@nightnetwork/dusk-sqlite': { version: '1.0.0', resolved: 'https://registry.dusk.night-x.com/@nightnetwork/dusk-sqlite/-/dusk-sqlite-1.0.0.tgz', integrity: 'sha512-trusted' } } }),
  };
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true, seed, extensionCwd: '/project', extensions: [createSqliteExtension()] });
  const create = await repl.processManager.spawnSync('/bin/sqlite3', ['/tmp/test.db', "CREATE TABLE t(v); INSERT INTO t VALUES ('persisted')"], { cwd: '/' });
  const read = await repl.processManager.spawnSync('/bin/sqlite3', ['/tmp/test.db', 'SELECT v FROM t'], { cwd: '/' });
  const stdin = await repl.processManager.spawnSync('/bin/sqlite3', [':memory:'], { cwd: '/', stdin: new TextEncoder().encode('SELECT 42') });
  expect(create.status).toBe(0);
  expect(read.status, new TextDecoder().decode(read.stderr)).toBe(0);
  expect(new TextDecoder().decode(stdin.stdout).trim()).toBe('42');
  expect(new TextDecoder().decode(read.stdout).trim()).toBe('persisted');
  await repl.engine.terminate();
}, 60_000);
