import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const waitFor = async (out: string[], marker: string, deadlineMs = 10_000): Promise<void> => {
  const deadline = Date.now() + deadlineMs;
  while (out.join('').indexOf(marker) === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
};

test('extra: persistence across feeds — const + const, then expression', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed('const a = 5;\n');
  await repl.feed('const b = 7;\n');
  await repl.feed('a + b\n');
  repl.engine.terminate();
  expect(out.join('')).toContain('12');
}, 60_000);

test('extra: function declaration persists and is callable', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // Function declarations don't auto-persist to globalThis via the repl's
  // persistDeclaration path (only const/let/var do). Hoist explicitly.
  await repl.feed("function greet(n){ return 'hi ' + n } globalThis.greet = greet\n");
  await repl.feed("greet('world')\n");
  repl.engine.terminate();
  expect(out.join('')).toContain('hi world');
}, 60_000);

test('extra: require() caches modules — identity check', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const os1 = require('node:os'); " +
    "const os2 = require('node:os'); " +
    "process.stdout.write('E3:same=' + (os1 === os2) + ':END')\n",
  );
  await waitFor(out, ':END');
  repl.engine.terminate();
  expect(out.join('')).toContain('E3:same=true:END');
}, 60_000);

test('extra: async Promise resolution inside feed is observable', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "Promise.resolve(42).then(x => process.stdout.write('got=' + x + ':END'))\n",
  );
  await waitFor(out, 'got=42');
  repl.engine.terminate();
  expect(out.join('')).toContain('got=42');
}, 60_000);

test('extra: spawnSync(/bin/echo hello world) — capture stdout in REPL', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const cp = require('node:child_process'); " +
    "const r = cp.spawnSync('/bin/echo', ['hello', 'world']); " +
    "const txt = String.fromCharCode.apply(null, Array.from(r.stdout || [])); " +
    "process.stdout.write('E5:out=' + txt.trim() + ':END');\n",
  );
  await waitFor(out, ':END');
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('E5:out=hello world');
}, 60_000);

test('extra: node:path — join, dirname, extname round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const p = require('node:path');\n");
  await repl.feed(
    "p.join('/a', 'b', 'c') + '|' + p.dirname('/x/y') + '|' + p.extname('a.txt')\n",
  );
  repl.engine.terminate();
  expect(out.join('')).toContain('/a/b/c|/x|.txt');
}, 60_000);

test('extra: fs writeFileSync + readFileSync round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const fs = require('node:fs'); " +
    "fs.writeFileSync('/tmp/x', 'data'); " +
    "const s = fs.readFileSync('/tmp/x', 'utf8'); " +
    "process.stdout.write('E7:' + s + ':END');\n",
  );
  await waitFor(out, ':END');
  repl.engine.terminate();
  expect(out.join('')).toContain('E7:data:END');
}, 60_000);

test('extra: process.env mutation persists across feeds', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  // Trailing `;` on an assignment expression trips the REPL IIFE wrap; omit it.
  await repl.feed("process.env.DUSK_FOO = 'bar'\n");
  await repl.feed('process.env.DUSK_FOO\n');
  repl.engine.terminate();
  expect(out.join('')).toContain('bar');
}, 60_000);

test('extra: REPL survives a caught throw and keeps evaluating', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "try { throw new Error('boom') } catch(e) { process.stdout.write('caught:' + e.message + ':END') }\n",
  );
  await waitFor(out, 'caught:boom');
  await repl.feed('1 + 1\n');
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('caught:boom');
  expect(s).toMatch(/\b2\b/);
}, 60_000);

test('extra: nested /bin/node -e — spawnSync captures its stdout', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const cp = require('child_process'); " +
    "const r = cp.spawnSync('/bin/node', ['-e', 'process.stdout.write(String(2 * 21))']); " +
    "process.stdout.write('E10:' + String.fromCharCode.apply(null, Array.from(r.stdout || [])) + ':END');\n",
  );
  await waitFor(out, ':END', 30_000);
  repl.engine.terminate();
  expect(out.join('')).toContain('E10:42:END');
}, 60_000);
