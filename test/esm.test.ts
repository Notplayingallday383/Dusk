import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';

const runEsm = async (files: Record<string, string>, entry: string, afterImport = ''): Promise<string> => {
  const backend = createMemoryBackend();
  await backend.mkdir('/app', { recursive: true });
  await Promise.all(Object.keys(files).map((path) => backend.mkdir(path.split('/').slice(0, -1).join('/') || '/', { recursive: true })));
  await Promise.all(Object.entries(files).map(([path, source]) => backend.writeFile(path, source)));
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (text) => out.push(text)));
  try {
    await runner.run(`try { const module = await import(${JSON.stringify(entry)}); ${afterImport} } catch (error) { console.log(String(error)); }`);
    return out.join('');
  } finally {
    runner.stop();
  }
};

test('bundles SystemJS in the Dusk guest without browser loading APIs', async () => {
  const out: string[] = [];
  const runner = await createRunner(createFuncs(createMemoryBackend(), (text) => out.push(text)));
  try {
    await runner.run('console.log(typeof System);');
  } finally {
    runner.stop();
  }

  expect(out.join('')).toContain('object');
}, 60_000);

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

test('import lowers a static named import in a VFS module', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/dep.mjs', 'export const answer = 42;');
  await backend.writeFile('/main.mjs', "import { answer } from './dep.mjs'; export const value = answer;");
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  await runner.run("console.log((await import('./main.mjs')).value);");
  runner.stop();

  expect(out.join('')).toContain('42');
}, 60_000);

test('imported ESM modules retain strict mode without a source directive', async () => {
  const backend = createMemoryBackend();
  await backend.writeFile('/dep.mjs', 'export const loaded = true;');
  await backend.writeFile('/main.mjs', "import './dep.mjs'; export const strict = (() => { try { undeclaredAssignment = 1; return false; } catch (error) { return error instanceof ReferenceError; } })();");
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  await runner.run("console.log((await import('./main.mjs')).strict);");
  runner.stop();

  expect(out.join('')).toContain('true');
}, 60_000);

test('import loads Node compatibility subpath modules', async () => {
  const backend = createMemoryBackend();
  const out: string[] = [];
  const runner = await createRunner(createFuncs(backend, (t) => out.push(t)));
  await runner.run("const [mod, types, constants, streams] = await Promise.all([import('node:module'), import('node:util/types'), import('node:constants'), import('node:stream/promises')]); console.log(mod.builtinModules.includes('fs') && types.isDate(new Date()) && !!constants.SIGTERM && typeof streams.pipeline === 'function');");
  runner.stop();

  expect(out.join('')).toContain('true');
}, 60_000);

test('keeps imported bindings live after the exporter updates them', async () => {
  const output = await runEsm({
    '/app/source.mjs': 'export let count = 0; export const increment = () => count++;',
    '/app/consumer.mjs': "import { count, increment } from './source.mjs'; increment(); console.log(count);",
  }, '/app/consumer.mjs');

  expect(output).toContain('1');
}, 60_000);

test('rejects an absent named export before importer evaluation', async () => {
  const output = await runEsm({
    '/app/source.mjs': 'export const present = 1;',
    '/app/consumer.mjs': "import { absent } from './source.mjs'; console.log('importer side effect');",
  }, '/app/consumer.mjs');

  expect(output).toContain('absent');
  expect(output).not.toContain('importer side effect');
}, 60_000);

test('rejects an absent named re-export before importer evaluation', async () => {
  const output = await runEsm({
    '/app/source.mjs': 'export const present = 1;',
    '/app/bridge.mjs': "export { absent } from './source.mjs';",
    '/app/consumer.mjs': "import { absent } from './bridge.mjs'; console.log('importer side effect');",
  }, '/app/consumer.mjs');

  expect(output).toContain('absent');
  expect(output).not.toContain('importer side effect');
}, 60_000);

test('validates every named import from a repeated specifier', async () => {
  const output = await runEsm({
    '/app/source.mjs': 'export const present = 1;',
    '/app/consumer.mjs': "import { present } from './source.mjs'; import { absent } from './source.mjs'; console.log('importer side effect');",
  }, '/app/consumer.mjs');

  expect(output).toContain('absent');
  expect(output).not.toContain('importer side effect');
}, 60_000);

test('records destructured variable exports for named imports', async () => {
  const output = await runEsm({
    '/app/source.mjs': 'export const { first, nested: { second } } = { first: 1, nested: { second: 2 } };',
    '/app/consumer.mjs': "import { first, second } from './source.mjs'; console.log(first + ':' + second);",
  }, '/app/consumer.mjs');

  expect(output).toContain('1:2');
}, 60_000);

test('supports named and star re-exports', async () => {
  const output = await runEsm({
    '/app/source.mjs': 'export const named = 1; export const starred = 2;',
    '/app/re-export.mjs': "export { named as renamed } from './source.mjs'; export * from './source.mjs';",
    '/app/consumer.mjs': "import { renamed, starred } from './re-export.mjs'; console.log(renamed + ':' + starred);",
  }, '/app/consumer.mjs');

  expect(output).toContain('1:2');
}, 60_000);

test('handles cyclic and ambiguous star re-exports without recursive link checks', async () => {
  const output = await runEsm({
    '/app/a.mjs': "export * from './b.mjs'; export const shared = 'a';",
    '/app/b.mjs': "export * from './a.mjs'; export const shared = 'b';",
    '/app/consumer.mjs': "import { missing } from './a.mjs'; console.log('side effect');",
  }, '/app/consumer.mjs');

  expect(output).toContain('missing');
  expect(output).not.toContain('side effect');
}, 60_000);

test('keeps the complete CommonJS value as default and rejects absent named imports', async () => {
  const output = await runEsm({
    '/app/node_modules/cjs/package.json': JSON.stringify({ exports: { '.': { import: './index.cjs' } } }),
    '/app/node_modules/cjs/index.cjs': "module.exports = { default: 'property', named: 'ok' };",
    '/app/default.mjs': "import value, { named } from 'cjs'; console.log(value.default + ':' + named + ':' + (value === value.default));",
    '/app/missing.mjs': "import { absent } from 'cjs'; console.log('side effect');",
  }, '/app/default.mjs');

  expect(output).toContain('property:ok:false');
  const missing = await runEsm({
    '/app/node_modules/cjs/package.json': JSON.stringify({ exports: { '.': { import: './index.cjs' } } }),
    '/app/node_modules/cjs/index.cjs': "module.exports = { named: 'ok' };",
    '/app/missing.mjs': "import { absent } from 'cjs'; console.log('side effect');",
  }, '/app/missing.mjs');
  expect(missing).toContain('absent');
  expect(missing).not.toContain('side effect');
}, 60_000);

test('evaluates a simple cyclic module graph', async () => {
  const output = await runEsm({
    '/app/a.mjs': "import { b } from './b.mjs'; export const a = 'a'; export const seen = b;",
    '/app/b.mjs': "import { a } from './a.mjs'; export const b = a || 'b';",
    '/app/consumer.mjs': "import { seen } from './a.mjs'; console.log(seen);",
  }, '/app/consumer.mjs');

  expect(output).toContain('b');
}, 60_000);

test('evaluates dependencies before importer side effects', async () => {
  const output = await runEsm({
    '/app/dependency.mjs': "console.log('dependency'); export const value = true;",
    '/app/consumer.mjs': "import './dependency.mjs'; console.log('importer');",
  }, '/app/consumer.mjs');

  expect(output.indexOf('dependency')).toBeLessThan(output.indexOf('importer'));
}, 60_000);

test('imports Dusk built-ins and JSON through the SystemJS graph', async () => {
  const output = await runEsm({
    '/app/data.json': '{"answer":42}',
    '/app/consumer.mjs': "import path from 'node:path'; import data from './data.json'; console.log(path.basename('/app/file.js') + ':' + data.answer);",
  }, '/app/consumer.mjs');

  expect(output).toContain('file.js:42');
}, 60_000);

test('imports the Vite-required node:path named and default API', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import path, { basename, delimiter, dirname, extname, format, isAbsolute, join, normalize, parse, posix, relative, resolve, sep, win32 } from 'node:path'; console.log(JSON.stringify({ keys: Object.keys(path).sort(), values: [basename('/app/file.js'), delimiter, dirname('/app/file.js'), extname('/app/file.js'), format({ dir: '/app', name: 'file', ext: '.js' }), isAbsolute('/app'), join('/app', 'file.js'), normalize('/app/./file.js'), parse('/app/file.js').base, posix === path, relative('/app', '/app/file.js'), resolve('/app', 'file.js'), sep, win32.sep] }));",
  }, '/app/consumer.mjs');

  expect(output).toContain('"keys":["basename","delimiter","dirname","extname","format","isAbsolute","join","normalize","parse","posix","relative","resolve","sep","win32"]');
  expect(output).toContain('"values":["file.js",":","/app",".js","/app/file.js",true,"/app/file.js","/app/file.js","file.js",true,"file.js","/app/file.js","/","\\\\"]');
}, 60_000);

test('imports TLS aliases through the SystemJS graph', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import tls from 'tls'; import * as nodeTls from 'node:tls'; console.log((tls === nodeTls.default) + ':' + typeof nodeTls.connect);",
  }, '/app/consumer.mjs');

  expect(output).toContain('true:function');
}, 60_000);

test('preserves builtin defaults alongside namespace and named exports', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import EventEmitter, * as events from 'events'; import { EventEmitter as NamedEventEmitter } from 'events'; class X extends EventEmitter {} console.log((new X() instanceof EventEmitter) + ':' + (events.default === EventEmitter) + ':' + (events.EventEmitter === NamedEventEmitter));",
  }, '/app/consumer.mjs');

  expect(output).toContain('true:true:true');
}, 60_000);

test('preserves node:events default and named exports through SystemJS', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import DefaultEventEmitter, { EventEmitter } from 'node:events'; console.log(typeof DefaultEventEmitter + ':' + (DefaultEventEmitter === EventEmitter) + ':' + (new EventEmitter() instanceof DefaultEventEmitter));",
  }, '/app/consumer.mjs');

  expect(output).toContain('function:true:true');
}, 60_000);

test('maps the events default export EventEmitter property to itself', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import events from 'events'; class FSWatcher extends events.EventEmitter {} console.log((events.EventEmitter === events) + ':' + (new FSWatcher() instanceof events));",
  }, '/app/consumer.mjs');

  expect(output).toContain('true:true');
}, 60_000);

test('initializes EventEmitter state for an ESM named-import subclass', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import { EventEmitter } from 'node:events'; class Server extends EventEmitter {} const server = new Server(); server.on('ready', () => {}); console.log(server.listenerCount('ready'));",
  }, '/app/consumer.mjs');

  expect(output).toContain('1');
}, 60_000);

test('initializes EventEmitter state for an ESM default-import HTTP server', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import http from 'node:http'; const server = http.createServer(); server.on('upgrade', () => {}); console.log(server.listenerCount('upgrade'));",
  }, '/app/consumer.mjs');

  expect(output).toContain('1');
}, 60_000);

test('imports a CommonJS target selected by an ESM package condition', async () => {
  const output = await runEsm({
    '/app/node_modules/cjs-target/package.json': JSON.stringify({ exports: { '.': { import: './index.cjs' } } }),
    '/app/node_modules/cjs-target/index.cjs': "module.exports = { answer: 42, named: 'ok' };",
    '/app/consumer.mjs': "import pkg, { named } from 'cjs-target'; console.log(pkg.answer + ':' + named);",
  }, '/app/consumer.mjs');

  expect(output).toContain('42:ok');
}, 60_000);

test('resolves relative dynamic imports and provides a canonical file URL for VFS import.meta.url', async () => {
  const output = await runEsm({
    '/app/dynamic.mjs': 'export const value = 42;',
    '/app/consumer.mjs': "export const url = import.meta.url; export const load = () => import('./dynamic.mjs');",
  }, '/app/consumer.mjs', "const dynamic = await module.load(); console.log(dynamic.value + ':' + module.url);");

  expect(output).toContain('42:file:///app/consumer.mjs');
}, 60_000);

test('node:fs reads a VFS file through a local import.meta URL', async () => {
  const output = await runEsm({
    '/app/local.txt': 'local fixture',
    '/app/consumer.mjs': "import { readFileSync } from 'node:fs'; console.log(readFileSync(new URL('./local.txt', import.meta.url), 'utf8'));",
  }, '/app/consumer.mjs');

  expect(output).toContain('local fixture');
}, 60_000);

test('node:fs rejects non-file URLs and file URLs with remote hosts', async () => {
  const output = await runEsm({
    '/app/consumer.mjs': "import { readFileSync } from 'node:fs'; for (const url of [new URL('https://example.test/local.txt'), new URL('file://example.test/local.txt')]) { try { readFileSync(url, 'utf8'); } catch (error) { console.log(error.code); } }",
  }, '/app/consumer.mjs');

  expect(output).toContain('ERR_INVALID_URL_SCHEME');
  expect(output).toContain('ERR_INVALID_FILE_URL_HOST');
}, 60_000);
