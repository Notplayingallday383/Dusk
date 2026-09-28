import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:path resolves via require', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed('const path = require("node:path"); console.log(path.join("/a", "b", "c.txt"))\n');
  await repl.feed('console.log(path.dirname("/a/b/c.txt"))\n');
  await repl.feed('console.log(path.basename("/a/b/c.txt"))\n');
  await repl.feed('console.log(path.extname("/a/b/c.txt"))\n');
  await repl.feed('console.log(path.resolve("/foo", "bar", "../baz"))\n');
  const text = out.join('');
  expect(text).toContain('/a/b/c.txt');
  expect(text).toContain('/a/b');
  expect(text).toContain('c.txt');
  expect(text).toContain('.txt');
  expect(text).toContain('/foo/baz');
}, 60_000);

test('node:path exposes posix and win32 aliases via require', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed('const path = require("node:path"); const parsed = path.win32.parse("C:\\\\work\\\\vite.config.ts"); console.log([path.posix === path, path.win32.sep, parsed.root, parsed.dir, parsed.base, parsed.ext, parsed.name].join("|"))\n');

  expect(out.join('')).toContain('true|\\|C:\\|C:\\work|vite.config.ts|.ts|vite.config');
}, 60_000);

test('node:path normalize preserves relative paths and normalizes POSIX dot segments', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed('const path = require("node:path"); console.log([path.normalize("assets/../main.js"), path.normalize("foo/./bar/"), path.normalize("../foo"), path.normalize("/assets/../main.js"), path.normalize("foo/../"), path.normalize("./"), path.normalize("")].join("|"))\n');

  expect(out.join('')).toContain('main.js|foo/bar/|../foo|/main.js|./|./|.');
}, 60_000);

test('node:fs promises round-trips via require', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // Post plan-1 (binary FS): fs.promises.readFile without encoding returns a Buffer (Node-correct).
  // Decode explicitly to keep the string assertion meaningful.
  await repl.feed('const fs = require("node:fs"); await fs.promises.writeFile("/n.txt", "node-fs-works"); console.log((await fs.promises.readFile("/n.txt")).toString("utf8"))\n');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('node-fs-works') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(out.join('')).toContain('node-fs-works');
}, 60_000);

test('node:fs realpathSync.native aliases realpathSync', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    'const fs = require("node:fs"); fs.writeFileSync("/native-realpath.txt", "ok"); ' +
      'console.log([fs.realpathSync.native === fs.realpathSync, fs.realpathSync.native("/native-realpath.txt")].join("|"))\n',
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('true|/native-realpath.txt') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(out.join('')).toContain('true|/native-realpath.txt');
}, 60_000);

test('node:fs accessSync throws ENOENT with syscall+path', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    'const fs = require("node:fs"); (() => { try { fs.accessSync("/nope-access.txt"); } ' +
      'catch (e) { console.log("CODE=" + e.code + ";SYS=" + e.syscall + ";PATH=" + e.path); } })()\n',
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('CODE=') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = out.join('');
  expect(text).toContain('CODE=ENOENT;SYS=access;PATH=/nope-access.txt');
}, 60_000);

test('node:fs realpathSync.native throws ENOENT with syscall+path', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    'const fs = require("node:fs"); (() => { try { fs.realpathSync.native("/nope-real.txt"); } ' +
      'catch (e) { console.log("CODE=" + e.code + ";SYS=" + e.syscall + ";PATH=" + e.path); } })()\n',
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('CODE=') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = out.join('');
  expect(text).toContain('CODE=ENOENT;SYS=realpath;PATH=/nope-real.txt');
}, 60_000);

test('node:fs readFileSync ENOENT carries syscall (from call wrapper)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    'const fs = require("node:fs"); (() => { try { fs.readFileSync("/missing-rf.txt"); } ' +
      'catch (e) { console.log("CODE=" + e.code + ";SYS=" + e.syscall); } })()\n',
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('CODE=') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = out.join('');
  expect(text).toContain('CODE=ENOENT;SYS=readFile');
}, 60_000);
