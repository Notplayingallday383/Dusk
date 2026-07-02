import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('spawnSync stdout has Buffer-like toString', async () => {
  const lines: string[] = [];
  const write = (t: string): void => { lines.push(t); };
  const repl = await bootRepl(write, { fs: 'memory' });
  await repl.feed('const cp = require("node:child_process")\n');
  lines.length = 0;
  await repl.feed('cp.spawnSync("/bin/echo", ["hi"]).stdout\n');
  const out = lines.join('');
  expect(out).toContain('hi');
  expect(out).not.toMatch(/104,105/);
}, 60_000);
