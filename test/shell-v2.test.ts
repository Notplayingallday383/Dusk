import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// Smoke tests for shell-v2 (opt-in via DUSK_SHELL_V2=1)

const runScript = async (repl: { feed: (t: string) => Promise<void> }, script: string, out: string[]): Promise<void> => {
  await repl.feed("process.env.DUSK_SHELL_V2 = '1'\n");
  const escaped = script.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  await repl.feed(`const cp = require('node:child_process'); const r = cp.spawnSync('/bin/sh', ['-c', '${escaped}']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString('utf8') + '|STATUS=' + r.status + '|END\\n')\n`);
  await new Promise((r) => setTimeout(r, 700));
  void out;
};

test('shell-v2: echo with quoting and pipe', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'echo hello v2', out);
  expect(out.join('')).toContain('OUT=hello v2');
  expect(out.join('')).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: parameter expansion default', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'echo ${MISSING:-fallback}', out);
  expect(out.join('')).toContain('OUT=fallback');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: arithmetic', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'echo $((2 + 3 * 4))', out);
  expect(out.join('')).toContain('OUT=14');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: if statement', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'if true; then echo yes; else echo no; fi', out);
  expect(out.join('')).toContain('OUT=yes');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: for loop', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'for i in 1 2 3; do echo $i; done', out);
  const text = out.join('');
  expect(text).toContain('OUT=1\n2\n3');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: function definition and call', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'greet() { echo hello $1; }; greet world', out);
  expect(out.join('')).toContain('OUT=hello world');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: test builtin', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'if [ x = x ]; then echo eq; fi', out);
  expect(out.join('')).toContain('OUT=eq');
  repl.engine.terminate();
}, 60_000);

test('shell-v2: command substitution', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await runScript(repl, 'echo value: $(echo nested)', out);
  expect(out.join('')).toContain('OUT=value: nested');
  repl.engine.terminate();
}, 60_000);
