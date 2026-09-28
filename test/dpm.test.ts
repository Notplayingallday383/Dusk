import { expect, test } from 'vitest';
import { bootRepl } from '../src';
import { ProcessManager, type DpmWasmCommand } from '../src/host/process-manager';
import { createMemoryBackend, type FSBackend } from '../src/host/fs-backend';
import * as dpmWasm from '../src/host/dpm-wasm';

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const metadataTarball = (): Uint8Array => {
  const source = new TextEncoder().encode('{"name":"chalk","version":"5.4.1"}\n');
  const header = new Uint8Array(512);
  header.set(new TextEncoder().encode('package/package.json'));
  header.set(new TextEncoder().encode('0000644\0'), 100);
  header.set(new TextEncoder().encode(source.length.toString(8).padStart(11, '0') + '\0'), 124);
  header[156] = 48;
  header.set(new TextEncoder().encode('ustar\0'), 257);
  header.set(new TextEncoder().encode('00'), 263);
  header.fill(0x20, 148, 156);
  header.set(new TextEncoder().encode(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 '), 148);
  const result = new Uint8Array(2048);
  result.set(header);
  result.set(source, 512);
  return result;
};

const registryResponse = (status = 200, statusText = 'OK'): Response => {
  const tarball = metadataTarball();
  const body = async () => {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', tarball.slice().buffer));
    const integrity = `sha512-${btoa(String.fromCharCode(...hash))}`;
    return JSON.stringify({
    name: 'chalk',
    'dist-tags': { latest: '5.4.1' },
    versions: {
      '5.4.1': {
        name: 'chalk',
        version: '5.4.1',
        dist: { tarball: 'https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz', integrity },
      },
    },
    });
  };
  return {
    status,
    statusText,
    headers: new Map([['content-type', 'application/json']]),
    text: body,
    arrayBuffer: async () => tarball.buffer,
  } as unknown as Response;
};

const stubLibcurl = (requests: string[]) => ({
  load_wasm: async () => {},
  set_websocket: (_url: string) => {},
  fetch: async (url: string) => {
    requests.push(url);
    return registryResponse();
  },
  WebSocket: class {
    addEventListener() {}
    send() {}
    close() {}
  } as unknown as new (url: string, protocols?: string[]) => WebSocket,
});

test('/bin/dpm runs the generated Rust WASM command', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const result = await repl.processManager.spawnSync('/bin/dpm', ['--help'], { cwd: '/' });

  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toContain('Dusk Package Manager');
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm i uses the DPM registry while dpm npm install uses npmjs', async () => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const direct = await repl.processManager.spawnSync('/bin/dpm', ['i', 'chalk'], { cwd: '/' });
  const npm = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'kleur'], { cwd: '/' });

  expect(direct.status).toBe(0);
  expect(npm.status).toBe(0);
  expect(requests).toContain('https://registry.dusk.night-x.com/chalk');
  expect(requests).toContain('https://registry.npmjs.org/kleur');
  expect(requests).toContain('https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz');
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm install falls back from DPM 404s to npm for transitive JS bin packages', async () => {
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
    const result = new Uint8Array(entries.reduce((size, entry) => size + entry.length, 1024));
    let offset = 0;
    for (const entry of entries) { result.set(entry, offset); offset += entry.length; }
    return result;
  };
  const dpmTar = tar({
    'package.json': JSON.stringify({ name: 'dpm-tar', version: '1.0.0', dependencies: { nanotar: '^1.0.0' }, bin: { 'dpm-tar': 'bin/dpm-tar.js' } }),
    'bin/dpm-tar.js': 'process.stdout.write("dpm-tar-bin\\n");\n',
  });
  const nanotar = tar({ 'package.json': JSON.stringify({ name: 'nanotar', version: '1.0.0' }) });
  const integrity = async (bytes: Uint8Array): Promise<string> => `sha512-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', bytes.slice().buffer))))}`;
  const dpmTarIntegrity = await integrity(dpmTar);
  const nanotarIntegrity = await integrity(nanotar);
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl(requests),
        fetch: async (url: string) => {
          requests.push(url);
          if (url.startsWith('https://registry.dusk.night-x.com/')) {
            return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
          }
          const isTar = url.endsWith('dpm-tar.tgz');
          const isNano = url.endsWith('nanotar.tgz');
          if (isTar || isNano) {
            const bytes = isTar ? dpmTar : nanotar;
            return { status: 200, statusText: 'OK', headers: new Map(), text: async () => '', arrayBuffer: async () => bytes.buffer } as unknown as Response;
          }
          const name = url.endsWith('/dpm-tar') ? 'dpm-tar' : 'nanotar';
          const packageIntegrity = name === 'dpm-tar' ? dpmTarIntegrity : nanotarIntegrity;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            text: async () => JSON.stringify({
              name,
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': {
                  name,
                  version: '1.0.0',
                  ...(name === 'dpm-tar' ? { dependencies: { nanotar: '^1.0.0' }, bin: { 'dpm-tar': 'bin/dpm-tar.js' } } : {}),
                  dist: { tarball: `https://registry.npmjs.org/${name}/-/${name}.tgz`, integrity: packageIntegrity },
                },
              },
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          } as unknown as Response;
        },
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['install', 'dpm-tar'], { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(requests).toEqual(expect.arrayContaining([
    'https://registry.dusk.night-x.com/dpm-tar', 'https://registry.npmjs.org/dpm-tar',
    'https://registry.dusk.night-x.com/nanotar', 'https://registry.npmjs.org/nanotar',
  ]));
  const lock = JSON.parse(await fs.readFile('/project/package-lock.json'));
  expect(lock.packages['node_modules/dpm-tar'].resolved).toBe('https://registry.npmjs.org/dpm-tar/-/dpm-tar.tgz');
  expect(lock.packages['node_modules/dpm-tar/node_modules/nanotar'].resolved).toBe('https://registry.npmjs.org/nanotar/-/nanotar.tgz');
  const bin = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'dpm-tar'], { cwd: '/project' });
  expect(bin.status, decode(bin.stderr)).toBe(0);
  expect(decode(bin.stdout)).toBe('dpm-tar-bin\n');
  await repl.engine.terminate();
}, 60_000);

test.each([401, 500])('/bin/dpm install does not fall back from a DPM %i', async (status) => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl(requests),
        fetch: async (url: string) => {
          requests.push(url);
          return { status, statusText: 'Failure', headers: new Map(), text: async () => 'failure', arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
        },
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });

  const result = await repl.processManager.spawnSync('/bin/dpm', ['install', 'unavailable'], { cwd: '/' });

  expect(result.status).toBe(1);
  expect(requests).toEqual(['https://registry.dusk.night-x.com/unavailable']);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm install --no-npm-fallback preserves a DPM 404', async () => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl(requests),
        fetch: async (url: string) => {
          requests.push(url);
          return { status: 404, statusText: 'Not Found', headers: new Map(), text: async () => 'not found', arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
        },
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });

  const result = await repl.processManager.spawnSync('/bin/dpm', ['install', '--no-npm-fallback', 'unavailable'], { cwd: '/' });

  expect(result.status).toBe(1);
  expect(requests).toEqual(['https://registry.dusk.night-x.com/unavailable']);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm honors DPM_REGISTRY only for direct installs and lets --registry override both routes', async () => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });

  const direct = await repl.processManager.spawnSync('/bin/dpm', ['install', 'direct'], {
    cwd: '/', env: { DPM_REGISTRY: 'https://dpm.example/' },
  });
  const npm = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'npm'], {
    cwd: '/', env: { DPM_REGISTRY: 'https://dpm.example/' },
  });
  const directOverride = await repl.processManager.spawnSync('/bin/dpm', ['add', '--registry', 'https://override.example/', 'direct-override'], { cwd: '/' });
  const npmOverride = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', '--registry', 'https://override.example/', 'npm-override'], { cwd: '/' });

  expect(direct.status).toBe(0);
  expect(npm.status).toBe(0);
  expect(directOverride.status).toBe(0);
  expect(npmOverride.status).toBe(0);
  expect(requests).toContain('https://dpm.example/direct');
  expect(requests).toContain('https://registry.npmjs.org/npm');
  expect(requests).toContain('https://override.example/direct-override');
  expect(requests).toContain('https://override.example/npm-override');
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm npm install fetches packument and persists package and lock data through host capabilities', async () => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.mkdir('/usr/bin', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'chalk'], { cwd: '/project' });

  expect(result.status).toBe(0);
  expect(requests).toContain('https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz');
  expect(JSON.parse(await fs.readFile('/project/package.json'))).toMatchObject({ dependencies: { chalk: '^5.4.1' } });
  expect(JSON.parse(await fs.readFile('/project/package-lock.json'))).toMatchObject({
    lockfileVersion: 3,
    packages: { 'node_modules/chalk': { version: '5.4.1' } },
  });
  expect(JSON.parse(await fs.readFile('/project/node_modules/chalk/package.json'))).toMatchObject({ name: 'chalk', version: '5.4.1' });
  expect(await fs.exists('/project/.dpm-metadata-transaction.json')).toBe(false);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm selects the highest version for an npm comparator conjunction', async () => {
  const tarball = metadataTarball();
  const integrity = `sha512-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', tarball.slice().buffer))))}`;
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl([]),
        fetch: async () => ({
          status: 200,
          statusText: 'OK',
          headers: new Map(),
          text: async () => JSON.stringify({
            name: 'chalk',
            'dist-tags': { latest: '1.0.0' },
            versions: {
              '0.3.0': { name: 'chalk', version: '0.3.0', dist: { tarball: 'https://registry.example/chalk-0.3.0.tgz', integrity } },
              '0.9.0': { name: 'chalk', version: '0.9.0', dist: { tarball: 'https://registry.example/chalk-0.9.0.tgz', integrity } },
              '1.0.0': { name: 'chalk', version: '1.0.0', dist: { tarball: 'https://registry.example/chalk-1.0.0.tgz', integrity } },
            },
          }),
          arrayBuffer: async () => tarball.buffer,
        }) as unknown as Response,
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'chalk@>= 0.3.0 < 1'], { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(JSON.parse(await fs.readFile('/project/package-lock.json'))).toMatchObject({
    packages: { 'node_modules/chalk': { version: '0.9.0' } },
  });
  await repl.engine.terminate();
}, 60_000);

test.each([
  ['/bin/dpm', ['install', 'alpha', 'beta']],
  ['/bin/dpm', ['i', 'alpha', 'beta']],
  ['/bin/dpm', ['add', 'alpha', 'beta']],
  ['/bin/dpm', ['npm', 'install', 'alpha', 'beta']],
  ['/bin/npm', ['install', 'alpha', 'beta']],
])('%s installs every requested package in one transaction', async (binary, args) => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync(binary, args, { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(JSON.parse(await fs.readFile('/project/package.json')).dependencies).toMatchObject({ alpha: '^5.4.1', beta: '^5.4.1' });
  const lock = JSON.parse(await fs.readFile('/project/package-lock.json'));
  expect(lock.packages).toMatchObject({
    'node_modules/alpha': { version: '5.4.1' },
    'node_modules/beta': { version: '5.4.1' },
  });
  expect(await fs.exists('/project/node_modules/alpha/package.json')).toBe(true);
  expect(await fs.exists('/project/node_modules/beta/package.json')).toBe(true);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm npm installs an immutable GitHub source through its archive URL', async () => {
  const requests: string[] = [];
  const commit = '0123456789abcdef0123456789abcdef01234567';
  const source = `git+https://github.com/example/archive-package.git#${commit}`;
  const archive = `https://github.com/example/archive-package/archive/${commit}.tar.gz`;
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl(requests),
        fetch: async (url: string) => {
          requests.push(url);
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            text: async () => '',
            arrayBuffer: async () => metadataTarball().buffer,
          } as unknown as Response;
        },
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', source], { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(requests).toEqual([archive]);
  expect(JSON.parse(await fs.readFile('/project/package.json'))).toMatchObject({ dependencies: { chalk: source } });
  expect(JSON.parse(await fs.readFile('/project/package-lock.json'))).toMatchObject({
    packages: {
      'node_modules/chalk': {
        resolved: source,
        integrity: expect.stringMatching(/^sha512-/),
      },
    },
  });
  await repl.engine.terminate();
}, 60_000);

test.each([
  'git+https://github.com/example/archive-package.git#main',
  'git+ssh://github.com/example/archive-package.git#0123456789abcdef0123456789abcdef01234567',
  'git+https://token@github.com/example/archive-package.git#0123456789abcdef0123456789abcdef01234567',
  'git+https://code.example/example/archive-package.git#0123456789abcdef0123456789abcdef01234567',
])('/bin/dpm npm rejects unsupported Git source %s before fetching', async (source) => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', source], { cwd: '/project' });

  expect(result.status).toBe(1);
  expect(requests).toEqual([]);
  expect(await fs.readFile('/project/package.json')).toBe('{"name":"app"}\n');
  expect(await fs.exists('/project/package-lock.json')).toBe(false);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm installs a missing required peer at the project root', async () => {
  const encodeTarball = (manifest: object): Uint8Array => {
    const source = new TextEncoder().encode(`${JSON.stringify(manifest)}\n`);
    const header = new Uint8Array(512);
    header.set(new TextEncoder().encode('package/package.json'));
    header.set(new TextEncoder().encode('0000644\0'), 100);
    header.set(new TextEncoder().encode(source.length.toString(8).padStart(11, '0') + '\0'), 124);
    header[156] = 48;
    header.set(new TextEncoder().encode('ustar\0'), 257);
    header.set(new TextEncoder().encode('00'), 263);
    header.fill(0x20, 148, 156);
    header.set(new TextEncoder().encode(header.reduce((sum, byte) => sum + byte, 0).toString(8).padStart(6, '0') + '\0 '), 148);
    const result = new Uint8Array(2048);
    result.set(header);
    result.set(source, 512);
    return result;
  };
  const tarballs = {
    dependent: encodeTarball({ name: 'dependent', version: '1.0.0', dependencies: { ordinary: '1.0.0' }, peerDependencies: { peer: '^2.0.0' }, peerDependenciesMeta: { peer: { optional: false } } }),
    ordinary: encodeTarball({ name: 'ordinary', version: '1.0.0' }),
    peer: encodeTarball({ name: 'peer', version: '2.1.0' }),
  };
  const integrity = async (tarball: Uint8Array): Promise<string> => {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-512', tarball.slice().buffer));
    return `sha512-${btoa(String.fromCharCode(...hash))}`;
  };
  const packuments = Object.fromEntries(await Promise.all(Object.entries(tarballs).map(async ([name, tarball]) => [name, {
    name,
    'dist-tags': { latest: name === 'peer' ? '2.1.0' : '1.0.0' },
    versions: { [name === 'peer' ? '2.1.0' : '1.0.0']: { name, version: name === 'peer' ? '2.1.0' : '1.0.0', ...(name === 'dependent' ? { dependencies: { ordinary: '1.0.0' }, peerDependencies: { peer: '^2.0.0' }, peerDependenciesMeta: { peer: { optional: false } } } : {}), dist: { tarball: `https://registry.example/${name}.tgz`, integrity: await integrity(tarball) } } },
  }])));
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl([]),
        fetch: async (url: string) => {
          const name = url.split('/').at(-1)?.replace('.tgz', '')!;
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            text: async () => JSON.stringify(packuments[name as keyof typeof packuments] ?? ''),
            arrayBuffer: async () => tarballs[name as keyof typeof tarballs]?.buffer ?? new ArrayBuffer(0),
          } as unknown as Response;
        },
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'dependent'], { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(await fs.exists('/project/node_modules/peer/package.json')).toBe(true);
  expect(await fs.exists('/project/node_modules/dependent/node_modules/ordinary/package.json')).toBe(true);
  const lock = JSON.parse(await fs.readFile('/project/package-lock.json'));
  expect(lock.packages['node_modules/dependent']).toMatchObject({ peerDependencies: { peer: '^2.0.0' }, peerDependenciesMeta: { peer: { optional: false } } });
  expect(lock.packages['node_modules/peer'].peer).toBe(true);
  expect(lock.packages['node_modules/dependent'].peer).not.toBe(true);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm npm install reads cwd-relative file tarballs without network access', async () => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project/app', { recursive: true });
  await fs.mkdir('/project/fixtures', { recursive: true });
  await fs.writeFile('/project/app/package.json', '{"name":"app"}\n');
  await fs.writeFileBytes('/project/fixtures/chalk.tgz', metadataTarball());

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'file:../fixtures/chalk.tgz'], { cwd: '/project/app' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(requests).toEqual([]);
  expect(JSON.parse(await fs.readFile('/project/app/package-lock.json'))).toMatchObject({
    packages: {
      'node_modules/chalk': {
        resolved: 'file:/project/fixtures/chalk.tgz',
        integrity: expect.stringMatching(/^sha512-/),
      },
    },
  });
  expect(JSON.parse(await fs.readFile('/project/app/node_modules/chalk/package.json'))).toMatchObject({ name: 'chalk', version: '5.4.1' });
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm npm install copies a cwd-relative local directory without node_modules', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project/app', { recursive: true });
  await fs.mkdir('/project/fixtures/local/nested', { recursive: true });
  await fs.mkdir('/project/fixtures/local/node_modules', { recursive: true });
  await fs.writeFile('/project/app/package.json', '{"name":"app"}\n');
  await fs.writeFile('/project/fixtures/local/package.json', '{"name":"local-package","version":"2.0.0"}\n');
  await fs.writeFileBytes('/project/fixtures/local/nested/data.bin', new Uint8Array([0, 1, 2]));
  await fs.writeFile('/project/fixtures/local/node_modules/ignored.js', 'ignored');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'file:../fixtures/local'], { cwd: '/project/app' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(await fs.readFileBytes('/project/app/node_modules/local-package/nested/data.bin')).toEqual(new Uint8Array([0, 1, 2]));
  expect(await fs.exists('/project/app/node_modules/local-package/node_modules/ignored.js')).toBe(false);
  expect(JSON.parse(await fs.readFile('/project/app/package.json'))).toMatchObject({ dependencies: { 'local-package': 'file:../fixtures/local' } });
  expect(JSON.parse(await fs.readFile('/project/app/package-lock.json'))).toMatchObject({
    packages: { 'node_modules/local-package': { resolved: 'file:/project/fixtures/local', integrity: expect.stringMatching(/^sha512-/) } },
  });
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm npm install resolves a workspace package without network access', async () => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project/packages/local-package', { recursive: true });
  await fs.writeFile('/project/package.json', JSON.stringify({ name: 'app', workspaces: ['packages/*'] }));
  await fs.writeFile('/project/packages/local-package/package.json', JSON.stringify({ name: 'local-package', version: '2.0.0' }));
  await fs.writeFile('/project/packages/local-package/index.js', 'module.exports = "workspace";\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'local-package@workspace:^'], { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
  expect(requests).toEqual([]);
  expect(await fs.readFile('/project/node_modules/local-package/index.js')).toContain('workspace');
  expect(JSON.parse(await fs.readFile('/project/package.json'))).toMatchObject({ dependencies: { 'local-package': 'workspace:^' } });
  const lock = JSON.parse(await fs.readFile('/project/package-lock.json'));
  expect(lock).toMatchObject({
    packages: {
      'node_modules/local-package': {
        resolved: 'workspace:/project/packages/local-package',
        integrity: expect.stringMatching(/^sha512-/),
        workspace: true,
      },
    },
  });
  expect(lock.packages['node_modules/local-package'].link).not.toBe(true);
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm npm install uses its configured registry for encoded packuments and absolute tarballs', async () => {
  const requests: string[] = [];
  const registry = 'https://registry.example.test/api/';
  const tarball = metadataTarball();
  const integrity = `sha512-${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', tarball.slice().buffer))))}`;
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl(requests),
        fetch: async (url: string) => {
          requests.push(url);
          const name = url === `${registry}%40scope%2Fpackage` ? '@scope/package' : 'plain-package';
          return {
            status: 200,
            statusText: 'OK',
            headers: new Map(),
            text: async () => JSON.stringify({
              name,
              'dist-tags': { latest: '1.0.0' },
              versions: {
                '1.0.0': {
                  name,
                  version: '1.0.0',
                  dist: { tarball: `https://tarballs.example.test/${encodeURIComponent(name)}-1.0.0.tgz`, integrity },
                },
              },
            }),
            arrayBuffer: async () => tarball.buffer,
          } as unknown as Response;
        },
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const scoped = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', '--registry', registry, '@scope/package'], { cwd: '/project' });
  const unscoped = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', '--registry', registry, 'plain-package'], { cwd: '/project' });

  expect(scoped.status, decode(scoped.stderr)).toBe(0);
  expect(unscoped.status, decode(unscoped.stderr)).toBe(0);
  expect(requests).toEqual([
    `${registry}%40scope%2Fpackage`,
    `${registry}%40scope%2Fpackage`,
    'https://tarballs.example.test/%40scope%2Fpackage-1.0.0.tgz',
    `${registry}plain-package`,
    `${registry}plain-package`,
    'https://tarballs.example.test/plain-package-1.0.0.tgz',
  ]);
  await repl.engine.terminate();
}, 60_000);

test('npm install writes executable package source, nested dependencies, package-lock metadata, and a top-level bin shim', async () => {
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
      const checksum = header.reduce((sum, byte) => sum + byte, 0);
      header.set(new TextEncoder().encode(checksum.toString(8).padStart(6, '0') + '\0 '), 148);
      const padded = new Uint8Array(Math.ceil(body.length / 512) * 512);
      padded.set(body);
      entries.push(header, padded);
    }
    const uncompressed = new Uint8Array(entries.reduce((size, entry) => size + entry.length, 1024));
    let offset = 0;
    for (const entry of entries) { uncompressed.set(entry, offset); offset += entry.length; }
    return uncompressed;
  };
  const packageTarball = tar({
    'package.json': JSON.stringify({ name: 'fixture-package', version: '1.0.0', bin: { fixture: 'bin/fixture.js' }, scripts: { postinstall: 'do-not-run' } }),
    'index.js': 'module.exports = "fixture";\n',
    'bin/fixture.js': '#!/usr/bin/env node\nprocess.stdout.write("fixture-bin\\n");\n',
  });
  const dependencyTarball = tar({
    'package.json': JSON.stringify({ name: 'fixture-dependency', version: '1.0.0' }),
    'index.js': 'module.exports = "dependency";\n',
  });
  const integrity = async (bytes: Uint8Array): Promise<string> => {
    const input = bytes.slice();
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', input.buffer));
    return `sha256-${btoa(String.fromCharCode(...hash))}`;
  };
  const packageIntegrity = await integrity(packageTarball);
  const dependencyIntegrity = await integrity(dependencyTarball);
  const packument = (name: string, dependencies: Record<string, string> = {}, integrity = packageIntegrity) => JSON.stringify({
    name,
    'dist-tags': { latest: '1.0.0' },
    versions: { '1.0.0': { name, version: '1.0.0', dependencies, dist: { tarball: `https://registry.example/${name}.tgz`, integrity } } },
  });
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      loadLibcurl: async () => ({
        ...stubLibcurl([]),
        fetch: async (url: string) => ({
          status: 200,
          statusText: 'OK',
          headers: new Map(),
          text: async () => url.endsWith('fixture-package') ? packument('fixture-package', { 'fixture-dependency': '^1.0.0' }) : url.endsWith('fixture-dependency') ? packument('fixture-dependency', {}, dependencyIntegrity) : '',
          arrayBuffer: async () => (url.endsWith('fixture-package.tgz') ? packageTarball : dependencyTarball).buffer,
        } as unknown as Response),
      }) as never,
      proxyUrl: 'wss://stub/ws/',
    },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.mkdir('/usr/bin', { recursive: true });
  await fs.writeFile('/usr/bin/fixture', '#!/usr/bin/env node\nprocess.stdout.write("fallback-bin\\n");\n');
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'fixture-package'], { cwd: '/project' });

  expect(result.status, decode(result.stderr)).toBe(0);
    expect(decode(result.stderr)).toContain('lifecycle scripts for fixture-package@1.0.0 were not run');
    expect(await fs.readFile('/project/node_modules/fixture-package/index.js')).toContain('module.exports = "fixture"');
    expect(await fs.readFile('/project/node_modules/fixture-package/node_modules/fixture-dependency/index.js')).toContain('module.exports = "dependency"');
    expect(await fs.readFile('/project/node_modules/.bin/fixture')).toContain('/project/node_modules/fixture-package/bin/fixture.js');
    expect(await fs.exists('/project/node_modules/.bin/fixture-dependency')).toBe(false);
    expect(await fs.readFile('/usr/bin/fixture')).toContain('fallback-bin');
  const binResult = await repl.processManager.spawnSync('/bin/dsh', ['-c', './node_modules/.bin/fixture'], { cwd: '/project' });
  expect(binResult.status, decode(binResult.stderr)).toBe(0);
  expect(decode(binResult.stdout)).toBe('fixture-bin\n');
  const preferredBin = await repl.processManager.spawnSync('/bin/dsh', ['-c', 'fixture'], { cwd: '/project' });
  expect(preferredBin.status, decode(preferredBin.stderr)).toBe(0);
  expect(decode(preferredBin.stdout)).toBe('fixture-bin\n');
  expect(JSON.parse(await fs.readFile('/project/package-lock.json'))).toMatchObject({
    packages: {
      'node_modules/fixture-package': { version: '1.0.0' },
      'node_modules/fixture-package/node_modules/fixture-dependency': { version: '1.0.0' },
    },
  });
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm preserves existing lock entries on successive installs', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true, net: { loadLibcurl: async () => stubLibcurl([]) as never, proxyUrl: 'wss://stub/ws/' } });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.mkdir('/usr/bin', { recursive: true });
  await fs.writeFile('/usr/bin/fixture', '#!/usr/bin/env node\nprocess.stdout.write("fallback-bin\\n");\n');
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');
  await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'chalk'], { cwd: '/project' });
  await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'kleur'], { cwd: '/project' });

  const manifest = JSON.parse(await fs.readFile('/project/package.json'));
  const lock = JSON.parse(await fs.readFile('/project/package-lock.json'));
  expect(manifest.dependencies).toMatchObject({ chalk: '^5.4.1', kleur: '^5.4.1' });
  expect(lock.packages).toMatchObject({ 'node_modules/chalk': { version: '5.4.1' }, 'node_modules/kleur': { version: '5.4.1' } });
  await repl.engine.terminate();
}, 60_000);

test('/bin/dpm serializes concurrent installs in the same project', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true, net: { loadLibcurl: async () => stubLibcurl([]) as never, proxyUrl: 'wss://stub/ws/' } });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  await Promise.all([
    repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'chalk'], { cwd: '/project' }),
    repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'kleur'], { cwd: '/project' }),
  ]);

  expect(JSON.parse(await fs.readFile('/project/package.json')).dependencies).toMatchObject({ chalk: '^5.4.1', kleur: '^5.4.1' });
  expect(JSON.parse(await fs.readFile('/project/package-lock.json')).packages).toMatchObject({
    'node_modules/chalk': { version: '5.4.1' },
    'node_modules/kleur': { version: '5.4.1' },
  });
  await repl.engine.terminate();
}, 60_000);

test('concurrent DPM WASM callers share one module load and initialization', async () => {
  let moduleLoads = 0;
  let initializations = 0;
  const createLoader = (dpmWasm as unknown as {
    createDpmWasmCommandLoader: (load: () => Promise<{ default: () => Promise<unknown>; execute: DpmWasmCommand['execute'] }>) => () => Promise<DpmWasmCommand>;
  }).createDpmWasmCommandLoader;
  const load = createLoader(async () => {
    moduleLoads++;
    return {
      default: async () => { initializations++; await Promise.resolve(); },
      execute: () => ({ status: 0 }),
    };
  });

  const commands = await Promise.all([load(), load(), load()]);

  expect(commands[0]).toBe(commands[1]);
  expect(commands[1]).toBe(commands[2]);
  expect(moduleLoads).toBe(1);
  expect(initializations).toBe(1);
});

test('DPM WASM loader retries after the default initializer rejects', async () => {
  let moduleLoads = 0;
  let initializations = 0;
  const createLoader = (dpmWasm as unknown as {
    createDpmWasmCommandLoader: (load: () => Promise<{ default: () => Promise<unknown>; execute: DpmWasmCommand['execute'] }>) => () => Promise<DpmWasmCommand>;
  }).createDpmWasmCommandLoader;
  const load = createLoader(async () => {
    moduleLoads++;
    return {
      default: async () => {
        initializations++;
        if (initializations === 1) throw new Error('initialization failed');
      },
      execute: () => ({ status: 0 }),
    };
  });

  await expect(load()).rejects.toThrow('initialization failed');
  await expect(load()).resolves.toMatchObject({ execute: expect.any(Function) });
  expect(moduleLoads).toBe(2);
  expect(initializations).toBe(2);
});

test('/bin/dpm reports registry HTTP status without parsing an error response', async () => {
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => ({ ...stubLibcurl([]), fetch: async () => registryResponse(404, 'Not Found') }) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'install', 'chalk'], { cwd: '/project' });

  expect(result.status).toBe(1);
  expect(decode(result.stderr)).toContain('registry returned 404 Not Found for chalk');
  await repl.engine.terminate();
}, 60_000);

test.each([
  ['/bin/npm', ['install', 'chalk'], 'installed chalk@5.4.1\n'],
  ['/bin/pnpm', ['add', 'chalk'], 'installed chalk@5.4.1\n'],
])('%s normalizes through the real Rust WASM command', async (binary, args, stdout) => {
  const requests: string[] = [];
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: { loadLibcurl: async () => stubLibcurl(requests) as never, proxyUrl: 'wss://stub/ws/' },
  });
  const fs = (repl.processManager as unknown as { fs: FSBackend }).fs;
  await fs.mkdir('/project', { recursive: true });
  await fs.writeFile('/project/package.json', '{"name":"app"}\n');

  const result = await repl.processManager.spawnSync(binary, args, { cwd: '/project' });

  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toBe(stdout);
  if (args[0] === 'install' || args[0] === 'add') {
    expect(requests).toContain('https://registry.npmjs.org/chalk/-/chalk-5.4.1.tgz');
  } else {
    expect(requests).toEqual([]);
  }
  await repl.engine.terminate();
}, 60_000);

test.each([
  ['/bin/npx', ['/bin/dsh', '-c', 'printf "$DPM_EXEC_ENV:"; cat']],
  ['/bin/dpx', ['/bin/dsh', '-c', 'printf "$DPM_EXEC_ENV:"; cat']],
  ['/bin/pnpm', ['dlx', '/bin/dsh', '-c', 'printf "$DPM_EXEC_ENV:"; cat']],
])('%s preserves caller environment and stdin when executing its Rust-provided plan', async (binary, args) => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });

  const result = await repl.processManager.spawnSync(binary, args, {
    cwd: '/',
    env: { DPM_EXEC_ENV: 'preserved' },
    stdin: 'from-stdin',
  });

  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toBe('preserved:from-stdin');
  expect(decode(result.stderr)).toBe('');
  await repl.engine.terminate();
}, 60_000);

test('DPM host binary routes help through the Rust WASM command', async () => {
  const commands: string[][] = [];
  const rust: DpmWasmCommand = {
    execute: (args) => {
      commands.push(args);
      return { status: 0, stdout: 'dpm - Dusk Package Manager\n' };
    },
  };
  const pm = new ProcessManager(createMemoryBackend(), {}, {}, { dpmWasm: rust });

  const result = await pm.spawnSync('/bin/dpm', ['--help']);

  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toContain('Dusk Package Manager');
  expect(commands).toEqual([['--help']]);
});

test('DPM host binary executes a typed Rust execution plan through ProcessManager', async () => {
  const pm = new ProcessManager(createMemoryBackend(), {}, {}, {
    dpmWasm: {
      execute: () => ({ status: 0, plan: { command: '/bin/dsh', args: ['-c', 'printf host-plan'], env: {} } }),
    },
  });

  const result = await pm.spawnSync('/bin/dpm', ['npm', 'exec', 'ignored']);

  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toBe('host-plan');
  expect(decode(result.stderr)).toBe('');
});

test('DPM execution plans may invoke DPM again in the same project', async () => {
  const repl = await bootRepl(() => {}, { fs: 'memory', skipPidZero: true });

  const result = await repl.processManager.spawnSync('/bin/dpm', ['npm', 'exec', '/bin/dpm', '--help'], { cwd: '/project' });

  expect(result.status).toBe(0);
  expect(decode(result.stdout)).toContain('Dusk Package Manager');
  await repl.engine.terminate();
}, 2_000);

test.each([
  ['/bin/npm', ['install', 'chalk'], ['npm', 'install', 'chalk']],
  ['/bin/pnpm', ['add', 'chalk'], ['npm', 'install', 'chalk']],
  ['/bin/npx', ['vite'], ['npm', 'exec', 'vite']],
  ['/bin/dpx', ['vite'], ['npm', 'exec', 'vite']],
  ['/bin/pnpm', ['dlx', 'vite'], ['npm', 'exec', 'vite']],
])('%s normalizes arguments before routing to Rust DPM', async (binary, args, expected) => {
  const commands: string[][] = [];
  const pm = new ProcessManager(createMemoryBackend(), {}, {}, {
    dpmWasm: {
      execute: (argv) => {
        commands.push(argv);
        return { status: 0 };
      },
    },
  });

  const result = await pm.spawnSync(binary, args);

  expect(result.status).toBe(0);
  expect(commands).toEqual([expected]);
});
