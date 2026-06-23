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

test('node:fs promises round-trips via require', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed('const fs = require("node:fs"); await fs.promises.writeFile("/n.txt", "node-fs-works"); console.log(await fs.promises.readFile("/n.txt"))\n');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('node-fs-works') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(out.join('')).toContain('node-fs-works');
}, 60_000);
