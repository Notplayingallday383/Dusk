import { expect, test } from 'vitest';
import { createNativePackageRegistry } from '../src/host/native-package-registry';
import { esbuildWasmReplacementSource } from '../src/host/esbuild-wasm';
import { createMemoryBackend } from '../src/host/fs-backend';
import { ProcessManager } from '../src/host/process-manager';
import { resolveModule } from '../src/host/module-resolver';

test('resolves an allowlisted replacement to a canonical virtual path', () => {
  const registry = createNativePackageRegistry({
    'rollup/parseAst': 'module.exports = { parse() {} };',
  });

  const path = registry.resolve('rollup/parseAst');

  expect(path).toBe('/.dusk-native-fallback/rollup%2FparseAst.js');
  expect(registry.readSource(path!)).toBe('module.exports = { parse() {} };');
  expect(Object.isFrozen(registry)).toBe(true);
});

test('provides the exact esbuild browser replacement without a Rollup replacement', () => {
  const registry = createNativePackageRegistry({ esbuild: esbuildWasmReplacementSource });

  const esbuildPath = registry.resolve('esbuild');

  expect(esbuildPath).toBe('/.dusk-native-fallback/esbuild.js');
  expect(registry.resolve('rollup')).toBeUndefined();
  expect(registry.readSource(esbuildPath!)).toContain('module.exports.default = esbuild;');
  expect(registry.readSource(esbuildPath!)).toContain('formatMessages: api.formatMessages');
  expect(registry.readSource(esbuildPath!)).toContain('version: api.version');
});

test('only serves virtual source for an exact registered replacement', () => {
  const registry = createNativePackageRegistry({ 'rollup/parseAst': 'module.exports = {};' });

  expect(registry.resolve('rollup/parseAst/extra')).toBeUndefined();
  expect(() => registry.readSource('/.dusk-native-fallback/rollup%2FparseAst%2Fextra.js'))
    .toThrow(/ERR_DLOPEN_FAILED.*browser ABI/);
});

test('rejects invalid package keys and native addon targets', () => {
  for (const specifier of ['/absolute', './relative', 'pkg/../escape', 'pkg//subpath', 'pkg/addon.node']) {
    expect(() => createNativePackageRegistry({ [specifier]: 'module.exports = {};' }))
      .toThrow('Invalid native package replacement');
  }
});

test('rejects duplicate replacement registrations', () => {
  expect(() => createNativePackageRegistry([
    ['rollup/parseAst', 'module.exports = 1;'],
    ['rollup/parseAst', 'module.exports = 2;'],
  ])).toThrow('Duplicate native package replacement');
});

test('lets caller replacements override ProcessManager defaults', async () => {
  const fs = createMemoryBackend();
  const manager = new ProcessManager(fs, {}, {}, {
    nativePackageReplacements: { esbuild: 'module.exports = { source: "caller" };' },
  });
  manager.registerBinary('/bin/load-esbuild', 'process.stdout.write(require("esbuild").source);');

  const result = await manager.spawnSync('/bin/load-esbuild');

  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('caller');
}, 60_000);

test('rejects an unregistered native addon request with an actionable error', () => {
  const registry = createNativePackageRegistry({ 'rollup/parseAst': 'module.exports = {};' });

  expect(() => registry.resolve('native-addon/build/Release/addon.node'))
    .toThrow(/ERR_DLOPEN_FAILED.*browser ABI/);
});

test('rejects a native addon selected by package main', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/native-main', { recursive: true });
  await fs.writeFile('/app/node_modules/native-main/package.json', JSON.stringify({ main: './build/addon.node' }));
  await fs.mkdir('/app/node_modules/native-main/build', { recursive: true });
  await fs.writeFile('/app/node_modules/native-main/build/addon.node', 'unsafe source');

  await expect(resolveModule(fs, 'native-main', '/app', 'require')).rejects.toThrow(/ERR_DLOPEN_FAILED.*browser ABI/);
});

test('rejects a native addon selected by package exports', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/native-exports/build', { recursive: true });
  await fs.writeFile('/app/node_modules/native-exports/package.json', JSON.stringify({ exports: './build/addon.node' }));
  await fs.writeFile('/app/node_modules/native-exports/build/addon.node', 'unsafe source');

  await expect(resolveModule(fs, 'native-exports', '/app', 'require')).rejects.toThrow(/ERR_DLOPEN_FAILED.*browser ABI/);
});

test('rejects a native addon selected by package imports', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/build', { recursive: true });
  await fs.writeFile('/app/package.json', JSON.stringify({ imports: { '#native': './build/addon.node' } }));
  await fs.writeFile('/app/build/addon.node', 'unsafe source');

  await expect(resolveModule(fs, '#native', '/app', 'require')).rejects.toThrow(/ERR_DLOPEN_FAILED.*browser ABI/);
});

test('uses host replacements through pid-zero and spawned process resolution', async () => {
  const source = 'module.exports = { value: "fallback" };';
  const fs = createMemoryBackend();
  const manager = new ProcessManager(fs, {}, {}, {
    nativePackageReplacements: { 'rollup/parseAst': source },
  });
  const pidZeroOutput: string[] = [];
  const engine = await manager.createPidZero({}, (text) => pidZeroOutput.push(text));

  await engine.run("console.log(require('rollup/parseAst').value);");
  manager.registerBinary('/bin/native-fallback', "process.stdout.write(require('rollup/parseAst').value);");
  const spawned = await manager.spawnSync('/bin/native-fallback');
  await engine.terminate();

  expect(pidZeroOutput.join('')).toContain('fallback');
  expect(new TextDecoder().decode(spawned.stdout)).toBe('fallback');
}, 60_000);

test('async spawned processes report blocked native addons on stderr without evaluation', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app/node_modules/native-main/build', { recursive: true });
  await fs.writeFile('/app/node_modules/native-main/package.json', JSON.stringify({ main: './build/addon.node' }));
  await fs.writeFile('/app/node_modules/native-main/build/addon.node', "process.stdout.write('unsafe');");
  const manager = new ProcessManager(fs);
  manager.registerBinary('/bin/load-native', "globalThis.__duskRequireFrom('/app')('native-main');");

  const process = await manager.spawn('/bin/load-native', [], { cwd: '/app' });
  const status = await process.exit;
  const readStream = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
    }
    return new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])));
  };
  const stdout = await readStream(process.stdout);
  const stderr = await readStream(process.stderr);

  expect(status).not.toBe(0);
  expect(stdout).not.toContain('unsafe');
  expect(stderr).toMatch(/ERR_DLOPEN_FAILED.*browser ABI/);
}, 60_000);

test('async spawned processes resolve and run allowlisted browser replacements', async () => {
  const fs = createMemoryBackend();
  const manager = new ProcessManager(fs, {}, {}, {
    nativePackageReplacements: { 'native-package': "process.stdout.write('browser');" },
  });
  manager.registerBinary('/bin/load-fallback', "require('native-package');");

  const process = await manager.spawn('/bin/load-fallback');
  const status = await process.exit;
  const reader = process.stdout.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
  }

  expect(status).toBe(0);
  expect(new TextDecoder().decode(Uint8Array.from(chunks.flatMap((chunk) => [...chunk])))).toBe('browser');
}, 60_000);
