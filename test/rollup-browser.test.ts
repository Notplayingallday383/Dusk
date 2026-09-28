import { expect, test } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('official Rollup browser adapters expose Rollup and parser APIs', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/project/node_modules/vite/dist/node', { recursive: true });
  await fs.mkdir('/project/node_modules/vite/node_modules/rollup/dist', { recursive: true });
  await fs.writeFile('/project/node_modules/vite/node_modules/rollup/package.json', JSON.stringify({ version: '4.20.0', main: './dist/rollup.js' }));
  await fs.writeFile('/project/node_modules/vite/dist/node/rollup-adapter.cjs', `
    const rollup = require('rollup');
    const parser = require('rollup/parseAst');
    if (typeof rollup.rollup !== 'function') throw new Error('rollup export is not callable');
    if (typeof rollup.parseAst !== 'function' || typeof rollup.parseAstAsync !== 'function') throw new Error('rollup parser APIs are unavailable');
    if (typeof parser.parseAst !== 'function' || typeof parser.parseAstAsync !== 'function') throw new Error('rollup/parseAst APIs are unavailable');
    console.log('rollup adapter loaded');
  `);
  const manager = new ProcessManager(fs);
  const output: string[] = [];
  const engine = await manager.createPidZero({}, (text) => output.push(text));

  try {
    await engine.run('require("/project/node_modules/vite/dist/node/rollup-adapter.cjs");');
  } finally {
    await engine.terminate();
  }

  expect(output.join('')).toContain('rollup adapter loaded');
}, 60_000);

test('Rollup rejects absolute emitted asset filenames', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/project/node_modules/vite/dist/node', { recursive: true });
  await fs.mkdir('/project/node_modules/vite/node_modules/rollup/dist', { recursive: true });
  await fs.writeFile('/project/node_modules/vite/node_modules/rollup/package.json', JSON.stringify({ version: '4.20.0', main: './dist/rollup.js' }));
  await fs.writeFile('/project/node_modules/vite/dist/node/rollup-adapter.cjs', `
    const { rollup } = require('rollup');
    (async () => {
      const bundle = await rollup({
        input: 'entry.js',
        plugins: [{
          name: 'absolute-asset-filename',
          resolveId: (id) => id,
          load: () => 'export default 1;',
          buildStart() { this.emitFile({ type: 'asset', fileName: '/absolute.css', source: 'body {}' }); },
        }],
      });
      await bundle.generate({ format: 'es' });
    })().then(
      () => { throw new Error('absolute asset filename was accepted'); },
      (error) => {
        if (!/absolute|fileName|filename/i.test(String(error.message))) throw error;
        console.log('absolute asset filename rejected');
      },
    );
  `);
  const manager = new ProcessManager(fs);
  const output: string[] = [];
  const engine = await manager.createPidZero({}, (text) => output.push(text));

  try {
    await engine.run('require("/project/node_modules/vite/dist/node/rollup-adapter.cjs"); await new Promise((resolve) => setTimeout(resolve, 50));');
  } finally {
    await engine.terminate();
  }

  expect(output.join('')).toContain('absolute asset filename rejected');
}, 60_000);

test('official Rollup browser adapter writes chunks and byte assets through guest fs while preserving write hooks', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/project/node_modules/vite/dist/node', { recursive: true });
  await fs.mkdir('/project/node_modules/vite/node_modules/rollup/dist', { recursive: true });
  await fs.writeFile('/project/node_modules/vite/node_modules/rollup/package.json', JSON.stringify({ version: '4.20.0', main: './dist/rollup.js' }));
  await fs.writeFile('/project/node_modules/vite/dist/node/rollup-adapter.cjs', `
    const { rollup } = require('rollup');
    const fs = require('node:fs/promises');
    (async () => {
      const hooks = [];
      const bundle = await rollup({
        input: 'entry.js',
        plugins: [{
          name: 'entry-and-asset',
          resolveId: (id) => id === 'entry.js' ? id : null,
          load: (id) => id === 'entry.js' ? 'export const answer = 42;' : null,
          buildStart() { this.emitFile({ type: 'asset', fileName: 'asset.bin', source: new Uint8Array([0, 255, 128]) }); },
          generateBundle(_options, output, isWrite) {
            if (!isWrite || !output['entry.js'] || !output['asset.bin']) throw new Error('generateBundle write semantics lost');
            hooks.push('generateBundle');
          },
          writeBundle(_options, output) {
            if (!output['entry.js'] || !output['asset.bin']) throw new Error('writeBundle output missing');
            hooks.push('writeBundle');
          },
        }],
      });
      await bundle.write({ dir: '/project/dist', format: 'es', entryFileNames: 'entry.js' });
      const chunk = await fs.readFile('/project/dist/entry.js');
      const asset = await fs.readFile('/project/dist/asset.bin');
      if (!(chunk instanceof Uint8Array) || !new TextDecoder().decode(chunk).includes('answer = 42')) throw new Error('chunk was not written');
      if (!(asset instanceof Uint8Array) || asset.join(',') !== '0,255,128') throw new Error('asset bytes were not preserved');
      if (hooks.join(',') !== 'generateBundle,writeBundle') throw new Error('write hooks were not preserved');
      console.log('rollup write completed');
    })().catch((error) => console.log(String(error && error.stack || error)));
  `);
  const manager = new ProcessManager(fs);
  const output: string[] = [];
  const engine = await manager.createPidZero({}, (text) => output.push(text));

  try {
    await engine.run('require("/project/node_modules/vite/dist/node/rollup-adapter.cjs"); await new Promise((resolve) => setTimeout(resolve, 50));');
  } finally {
    await engine.terminate();
  }

  expect(output.join('')).toContain('rollup write completed');
}, 60_000);
