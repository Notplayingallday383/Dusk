import { expect, test } from 'vitest';
import { bootRepl } from '../src';
import type { FSBackend } from '../src/host/fs-backend';

const decoder = new TextDecoder();
const encoder = new TextEncoder();
const artifactUrls = {
  'tar-0.1.1.tgz': new URL('./fixtures/dpm-browser-archive/tar-0.1.1.tgz', import.meta.url),
  'zip-0.1.1.tgz': new URL('./fixtures/dpm-browser-archive/zip-0.1.1.tgz', import.meta.url),
  'unzip-0.1.1.tgz': new URL('./fixtures/dpm-browser-archive/unzip-0.1.1.tgz', import.meta.url),
  'nanotar-0.3.0.tgz': new URL('./fixtures/dpm-browser-archive/nanotar-0.3.0.tgz', import.meta.url),
  'fflate-0.8.3.tgz': new URL('./fixtures/dpm-browser-archive/fflate-0.8.3.tgz', import.meta.url),
} as const;

const integrity = async (bytes: Uint8Array): Promise<string> => {
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', bytes.slice().buffer));
  return `sha512-${btoa(String.fromCharCode(...hash))}`;
};

const artifact = async (name: keyof typeof artifactUrls): Promise<Uint8Array> => {
  const response = await fetch(artifactUrls[name]);
  if (!response.ok) throw new Error(`fixture artifact ${name}: ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
};

test.each(['memory', 'tfs'] as const)('DPM installs built archive artifacts and dsh round-trips bytes on %s storage', async (storage) => {
  const files = new Map<string, Uint8Array>([
    ['tar-0.1.1.tgz', await artifact('tar-0.1.1.tgz')],
    ['zip-0.1.1.tgz', await artifact('zip-0.1.1.tgz')],
    ['unzip-0.1.1.tgz', await artifact('unzip-0.1.1.tgz')],
    ['nanotar-0.3.0.tgz', await artifact('nanotar-0.3.0.tgz')],
    ['fflate-0.8.3.tgz', await artifact('fflate-0.8.3.tgz')],
  ]);
  const packages = new Map([
    ['tar', { version: '0.1.1', tarball: 'tar-0.1.1.tgz', dependencies: { nanotar: '^0.3.0' } }],
    ['zip', { version: '0.1.1', tarball: 'zip-0.1.1.tgz', dependencies: { fflate: '^0.8.3' } }],
    ['unzip', { version: '0.1.1', tarball: 'unzip-0.1.1.tgz', dependencies: { fflate: '^0.8.3' } }],
    ['nanotar', { version: '0.3.0', tarball: 'nanotar-0.3.0.tgz', dependencies: {} }],
    ['fflate', { version: '0.8.3', tarball: 'fflate-0.8.3.tgz', dependencies: {} }],
  ]);
  const repl = await bootRepl(() => {}, {
    fs: storage,
    skipPidZero: true,
    net: {
      proxyUrl: 'wss://archive.fixture/ws/',
      loadLibcurl: async () => ({
        load_wasm: async () => {},
        set_websocket: () => {},
        WebSocket: class {} as never,
        fetch: async (url: string) => {
          const name = url.slice(url.lastIndexOf('/') + 1);
          const bytes = files.get(name);
          if (bytes) return { status: 200, statusText: 'OK', headers: new Map(), text: async () => '', arrayBuffer: async () => bytes.slice().buffer } as never;
          const pkg = packages.get(name);
          if (!pkg) return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) } as never;
          const bytesForPackage = files.get(pkg.tarball)!;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            text: async () => JSON.stringify({
              name,
              'dist-tags': { latest: pkg.version },
              versions: {
                [pkg.version]: {
                  name,
                  version: pkg.version,
                  dependencies: pkg.dependencies,
                  dist: { tarball: `https://archive.fixture/${pkg.tarball}`, integrity: await integrity(bytesForPackage) },
                },
              },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          } as never;
        },
      }) as never,
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  const project = `/archive-artifacts-${storage}-${crypto.randomUUID()}`;
  await fs.mkdir(project, { recursive: true });
  await fs.writeFile(`${project}/package.json`, '{"name":"archive-artifacts"}\n');

  const install = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'dpm install tar@0.1.1 zip@0.1.1 unzip@0.1.1'], {
    cwd: project,
    env: { DPM_REGISTRY: 'https://archive.fixture/', PATH: '/bin' },
  });
  expect(install.status, decoder.decode(install.stderr)).toBe(0);

  const tarCreate = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'mkdir -p source/nested extracted; printf "tar bytes\\n" > source/nested/file; tar -cf archive.tar source'], { cwd: project });
  expect(tarCreate.status, decoder.decode(tarCreate.stderr)).toBe(0);
  const tarList = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'tar -tf archive.tar'], { cwd: project });
  expect(tarList.status, decoder.decode(tarList.stderr)).toBe(0);
  expect(decoder.decode(tarList.stdout)).toContain('source/nested/file');
  const tarExtract = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'tar -xf archive.tar -C extracted'], { cwd: project });
  expect(tarExtract.status, decoder.decode(tarExtract.stderr)).toBe(0);
  expect(await fs.readFileBytes(`${project}/extracted/source/nested/file`)).toEqual(encoder.encode('tar bytes\n'));

  const zipCreate = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'mkdir -p zip-extracted; printf "zip bytes\\n" > source/zip-file; zip -r archive.zip source'], { cwd: project });
  expect(zipCreate.status, decoder.decode(zipCreate.stderr)).toBe(0);
  const zipList = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'unzip -l archive.zip'], { cwd: project });
  expect(zipList.status, decoder.decode(zipList.stderr)).toBe(0);
  expect(decoder.decode(zipList.stdout)).toContain('source/zip-file');
  const zipExtract = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'unzip archive.zip -d zip-extracted'], { cwd: project });
  expect(zipExtract.status, decoder.decode(zipExtract.stderr)).toBe(0);
  expect(await fs.readFileBytes(`${project}/zip-extracted/source/zip-file`)).toEqual(encoder.encode('zip bytes\n'));

  await repl.engine.terminate();
}, 120_000);
