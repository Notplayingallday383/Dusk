import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('/bin/node -e prints expression', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['-e', 'process.stdout.write(\"hello-from-node\")']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  expect(text).toContain('OUT=hello-from-node');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node runs a script from VFS', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    seed: { '/tmp/test.js': 'process.stdout.write("from-script");' },
  });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['/tmp/test.js']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  expect(text).toContain('OUT=from-script');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node --version prints node version', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['--version']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  expect(text).toContain('OUT=v');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node script can require node:fs and read file', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    seed: {
      '/tmp/data.txt': 'hello-data',
      '/tmp/reader.js': "const fs = require('node:fs'); process.stdout.write(fs.readFileSync('/tmp/data.txt', 'utf8'));",
    },
  });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['/tmp/reader.js']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 1000));
  const text = out.join('');
  expect(text).toContain('OUT=hello-data');
  repl.engine.terminate();
}, 60_000);
