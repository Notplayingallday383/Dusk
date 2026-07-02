import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:process exposes pid, env, cwd/chdir, nextTick, hrtime, signal registration', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "(async () => { " +
    "const proc = require('node:process'); " +
    "proc.env.DUSK_TEST = 'set-by-test'; " +
    "const before = proc.cwd(); " +
    "proc.chdir('/'); " +
    "const after = proc.cwd(); " +
    "let ticked = false; " +
    "await new Promise((r) => proc.nextTick(() => { ticked = true; r(undefined); })); " +
    "const h = proc.hrtime(); " +
    "let sigRegistered = false; " +
    "try { proc.on('SIGINT', () => {}); sigRegistered = true; } catch (e) { sigRegistered = false; } " +
    "process.stdout.write('P:pid=' + proc.pid + '|env=' + proc.env.DUSK_TEST + '|cwdBefore=' + before + '|cwdAfter=' + after + '|tick=' + ticked + '|hr=' + Array.isArray(h) + ',len=' + (Array.isArray(h)?h.length:0) + '|sig=' + sigRegistered + ':END'); " +
    "})()\n"
  );
  // Poll for the END sentinel because the IIFE is async.
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('P:pid=0|');
  expect(s).toContain('env=set-by-test');
  expect(s).toContain('cwdAfter=/');
  expect(s).toContain('tick=true');
  expect(s).toContain('hr=true,len=2');
  expect(s).toContain('sig=true');
  expect(s).toContain(':END');
}, 60_000);
