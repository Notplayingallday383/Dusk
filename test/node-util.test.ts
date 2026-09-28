import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:util promisify, inspect cycle, format, types.isDate', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "(async () => { " +
    "const util = require('node:util'); " +
    "const cb = (x, done) => done(null, x * 2); " +
    "const p = util.promisify(cb); " +
    "const v = await p(21); " +
    "const obj = { a: 1 }; obj.self = obj; " +
    "const inspected = util.inspect(obj); " +
    "const fmt = util.format('%s %d %o', 'hi', 7, { k: 1 }); " +
    "const isDate = util.types.isDate(new Date()); " +
    "const notDate = util.types.isDate(123); " +
    "process.stdout.write('U:promisify=' + v + '|cycle=' + (inspected.indexOf('Circular') !== -1 || inspected.indexOf('[Circular') !== -1) + '|fmt=' + fmt + '|isDate=' + isDate + '|notDate=' + notDate + ':END'); " +
    "})()\n"
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('U:promisify=42|');
  expect(s).toMatch(/cycle=true/);
  expect(s).toMatch(/fmt=hi 7 /);
  expect(s).toContain('isDate=true');
  expect(s).toContain('notDate=false');
}, 60_000);

test('Node compatibility subpath modules resolve through require', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const Module = require('node:module'); " +
    "const types = require('node:util/types'); " +
    "const constants = require('node:constants'); " +
    "const streams = require('node:stream/promises'); " +
    "const localRequire = Module.createRequire('/project/index.js'); " +
    "process.stdout.write('C:' + Module.builtinModules.includes('fs') + ':' + types.isDate(new Date()) + ':' + !!constants.SIGTERM + ':' + typeof streams.pipeline + ':' + localRequire('node:path').sep + ':END');\n"
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  repl.engine.terminate();

  expect(out.join('')).toContain('C:true:true:true:function:/:END');
}, 60_000);
