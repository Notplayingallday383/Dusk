import { expect, test } from 'vitest';
import { bootRepl, createMemoryBackend, loadDuskExtensions } from '../src';
import type { FSBackend } from '../src/host/fs-backend';

const host = { packageName: '@test/example-extension', entry: './host.js', activate: async (_fs: FSBackend) => ({ funcs: {}, binaries: {} }) };

const extensionManifest = JSON.stringify({
  duskExtension: 1,
  host: {
    entry: './host.js',
    binaries: [],
    functions: [],
  },
});

const install = async (fs: FSBackend, manifest = extensionManifest, integrity = 'sha512-trusted'): Promise<void> => {
  await fs.mkdir('/project/node_modules/@test/example-extension', { recursive: true });
  await fs.writeFile('/project/node_modules/@test/example-extension/package.json', JSON.stringify({
    name: '@test/example-extension', version: '1.0.0',
  }));
  await fs.writeFile('/project/node_modules/@test/example-extension/dusk.extension', manifest);
  await fs.writeFile('/project/package-lock.json', JSON.stringify({
    lockfileVersion: 3,
    packages: {
      'node_modules/@test/example-extension': {
        version: '1.0.0', resolved: 'https://registry.dusk.night-x.com/@test/example-extension/-/example-extension-1.0.0.tgz', integrity,
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
  await install(fs, extensionManifest, '');
  await expect(loadDuskExtensions(fs, '/project', [host])).rejects.toThrow('trusted lockfile integrity');
});

test('a lockfile-authorized generic extension activates only when explicitly supplied', async () => {
  const fs = createMemoryBackend();
  await install(fs);
  let activations = 0;
  await loadDuskExtensions(fs, '/project', [{ ...host, activate: async () => {
    activations++;
    return { funcs: {}, binaries: {} };
  } }]);
  expect(activations).toBe(1);
});
