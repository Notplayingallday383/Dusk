import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// bootRepl(..., { via: 'node' }) routes feed() through a spawned /bin/node's stdin.
// The child runs node:repl (see binaries/node/main.ts startRepl), so output uses
// node:repl's defaultWriter (see src/world/node-repl.ts:38-58).

test('via:node — 1 + 1 produces 2 in output', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory', via: 'node' });
  expect(repl.node).toBeDefined();
  // Give the child time to boot and print the welcome banner + first prompt.
  await new Promise((r) => setTimeout(r, 300));
  await repl.feed('1 + 1');
  // Allow child to evaluate and print result.
  await new Promise((r) => setTimeout(r, 500));
  const text = out.join('');
  // node:repl prints numbers via defaultWriter as String(v) → "2".
  expect(text).toContain('Welcome to Node.js');
  expect(text).toMatch(/\b2\b/);
  repl.node!.kill();
  repl.engine.terminate();
}, 60_000);

test('via:node — require(node:os).platform() returns linux', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory', via: 'node' });
  await new Promise((r) => setTimeout(r, 300));
  await repl.feed("require('node:os').platform()");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  // defaultWriter stringifies strings via JSON.stringify → `"linux"`.
  expect(text).toContain('linux');
  repl.node!.kill();
  repl.engine.terminate();
}, 60_000);

test('via:node — .exit dot-command cleanly exits the child', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory', via: 'node' });
  await new Promise((r) => setTimeout(r, 300));
  await repl.feed('.exit');
  // main.ts's server.on('exit') calls proc.exit(0), so the child terminates.
  const code = await Promise.race([
    repl.node!.exit,
    new Promise<number>((_r, rej) => setTimeout(() => rej(new Error('child did not exit')), 5000)),
  ]);
  expect(code).toBe(0);
  repl.engine.terminate();
}, 60_000);
