import { afterEach, beforeEach, expect, test } from 'vitest';
import { ProcessManager, type ProcessManagerOptions } from '../src/host/process-manager';
import { createMemoryBackend, createTfsBackend, type FSBackend } from '../src/host/fs-backend';
import { createLayoutBackend } from '../src/host/fs-layout';

const clearOpfs = async (): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  // @ts-expect-error values() is available on OPFS directory handles in Chromium
  for await (const [name] of root.entries()) await root.removeEntry(name, { recursive: true }).catch(() => {});
};

beforeEach(clearOpfs);
afterEach(clearOpfs);

const tar = (files: Record<string, string>): Uint8Array => {
  const entries: Uint8Array[] = [];
  for (const [name, source] of Object.entries(files)) {
    const body = new TextEncoder().encode(source);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode(`package/${name}`));
    header.set(new TextEncoder().encode('0000644\0'), 100);
    header.set(new TextEncoder().encode(body.length.toString(8).padStart(11, '0') + '\0'), 124);
    header[156] = '0'.charCodeAt(0);
    header.set(new TextEncoder().encode('ustar\0'), 257);
    header.set(new TextEncoder().encode('00'), 263);
    header.fill(0x20, 148, 156);
    header.set(new TextEncoder().encode(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 '), 148);
    const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
    padded.set(body);
    entries.push(header, padded);
  }
  const archive = new Uint8Array(entries.reduce((size, entry) => size + entry.length, 1024));
  let offset = 0;
  for (const entry of entries) { archive.set(entry, offset); offset += entry.length; }
  return archive;
};

const createProjectLayout = async (persistent: FSBackend, options: ProcessManagerOptions = {}) => {
  const ephemeral = createMemoryBackend();
  const processManager = new ProcessManager(persistent, {}, {}, options);
  const layout = await createLayoutBackend({ persistent, ephemeral, processManager, user: 'user', hostname: 'dusk' });
  (processManager as unknown as { fs: FSBackend }).fs = layout;
  return { layout, processManager };
};

test('/bin/dpm rejects a TFS registry response without integrity metadata', async () => {
  const project = '/dpm-tfs-project';
  const response = {
    status: 200,
    statusText: 'OK',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'chalk', 'dist-tags': { latest: '5.4.1' }, versions: { '5.4.1': { name: 'chalk', version: '5.4.1', dist: { tarball: 'https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz' } } } }),
  };
  const firstFs = await createTfsBackend();
  const first = new ProcessManager(firstFs, {}, {}, { dpmFetch: async () => response });
  await firstFs.mkdir(project, { recursive: true });
  await firstFs.writeFile(`${project}/package.json`, '{"name":"persistent-app"}\n');

  expect((await first.spawnSync('/bin/dpm', ['npm', 'install', 'chalk'], { cwd: project })).status).toBe(1);
  expect(await firstFs.exists(`${project}/package-lock.json`)).toBe(false);
}, 60_000);

test('/bin/dpm recovers an interrupted metadata journal in an isolated TFS project', async () => {
  const project = `/dpm-tfs-recovery-${crypto.randomUUID()}`;
  const originalManifest = '{"name":"recovery-app"}\n';
  const originalLock = '{"lockfileVersion":3,"packages":{}}\n';
  const fs = await createTfsBackend();
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(`${project}/package.json`, '{"name":"interrupted-app"}\n');
  await fs.writeFile(`${project}/package-lock.json`, '{"lockfileVersion":3,"packages":{"":{"name":"interrupted-app"}}}\n');
  await fs.writeFile(`${project}/.dpm-metadata-transaction.json`, JSON.stringify({
    files: [
      { path: `${project}/package.json`, content: originalManifest },
      { path: `${project}/package-lock.json`, content: originalLock },
      { path: `${project}/node_modules/chalk/package.json`, content: null },
    ],
  }));

  const manager = new ProcessManager(fs);
  const result = await manager.spawnSync('/bin/dpm', ['--help'], { cwd: project });

  expect(result.status).toBe(0);
  expect(await fs.readFile(`${project}/package.json`)).toBe(originalManifest);
  expect(await fs.readFile(`${project}/package-lock.json`)).toBe(originalLock);
  expect(await fs.exists(`${project}/node_modules/chalk/package.json`)).toBe(false);
  expect(await fs.exists(`${project}/.dpm-metadata-transaction.json`)).toBe(false);
}, 60_000);

test('a DPM project and its bin survive TFS layout recreation at /project', async () => {
  const fixtureTarball = tar({
    'package.json': JSON.stringify({ name: 'persistent-fixture', version: '1.0.0', bin: { 'persistent-fixture': 'bin/fixture.js' } }),
    'bin/fixture.js': 'process.stdout.write("persistent-fixture-bin\\n");\n',
  });
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', fixtureTarball.slice().buffer));
  const integrity = `sha256-${btoa(String.fromCharCode(...hash))}`;
  const dpmFetch = async () => ({
    status: 200,
    statusText: 'OK',
    headers: {},
    body: JSON.stringify({
      name: 'persistent-fixture',
      'dist-tags': { latest: '1.0.0' },
      versions: { '1.0.0': { name: 'persistent-fixture', version: '1.0.0', bin: { 'persistent-fixture': 'bin/fixture.js' }, dist: { tarball: 'https://registry.example/persistent-fixture.tgz', integrity } } },
    }),
  });
  const first = await createProjectLayout(await createTfsBackend(), { dpmFetch, dpmFetchBytes: async () => fixtureTarball });
  await first.layout.writeFile('/project/package.json', '{"name":"persistent-app"}\n');
  const installed = await first.processManager.spawnSync('/bin/dpm', ['install', 'persistent-fixture'], { cwd: '/project' });
  expect(installed.status, new TextDecoder().decode(installed.stderr)).toBe(0);
  expect(await first.layout.exists('/project/node_modules/.bin/persistent-fixture')).toBe(true);
  await first.layout.mkdir('/project/test3', { recursive: true });

  const second = await createProjectLayout(await createTfsBackend());
  expect(JSON.parse(await second.layout.readFile('/project/package.json'))).toMatchObject({
    name: 'persistent-app',
    dependencies: { 'persistent-fixture': '^1.0.0' },
  });
  expect(await second.layout.exists('/project/package-lock.json')).toBe(true);
  expect(await second.layout.exists('/project/node_modules/.bin/persistent-fixture')).toBe(true);

  const which = await second.processManager.spawnSync('/bin/dsh', ['-c', 'which persistent-fixture'], { cwd: '/project/test3' });
  expect(which.status, new TextDecoder().decode(which.stderr)).toBe(0);
  expect(new TextDecoder().decode(which.stdout)).toContain('/project/node_modules/.bin/persistent-fixture');
  const invoked = await second.processManager.spawnSync('/bin/dsh', ['-c', 'persistent-fixture'], { cwd: '/project/test3' });
  expect(invoked.status, new TextDecoder().decode(invoked.stderr)).toBe(0);
  expect(new TextDecoder().decode(invoked.stdout)).toBe('persistent-fixture-bin\n');
}, 60_000);
