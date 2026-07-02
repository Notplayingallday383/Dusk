import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('process.chdir throws ENOENT for missing directory and does not update cwd', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const before = process.cwd();" +
    "let caught = null;" +
    "try { process.chdir('/does-not-exist-xyz'); } catch (e) { caught = { code: e.code, msg: String(e.message || e) }; }" +
    "const after = process.cwd();" +
    "process.stdout.write('before=' + before + '|after=' + after + '|code=' + (caught && caught.code) + '|msg=' + (caught && caught.msg))\n"
  );
  repl.engine.terminate();
  const text = out.join('');
  expect(text).toMatch(/before=([^|]+)\|after=\1\|/); // cwd unchanged
  expect(text).toContain('code=ENOENT');
}, 60_000);

test('process.chdir throws ENOTDIR when path is a file', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const fs = require('fs');" +
    "fs.writeFileSync('/tmp-file', 'x');" +
    "let caught = null;" +
    "try { process.chdir('/tmp-file'); } catch (e) { caught = e.code; }" +
    "process.stdout.write('code=' + caught)\n"
  );
  repl.engine.terminate();
  expect(out.join('')).toContain('code=ENOTDIR');
}, 60_000);

test('process.chdir succeeds for existing directory and updates cwd', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const fs = require('fs');" +
    "fs.mkdirSync('/sub', { recursive: true });" +
    "process.chdir('/sub');" +
    "process.stdout.write('cwd=' + process.cwd())\n"
  );
  repl.engine.terminate();
  expect(out.join('')).toContain('cwd=/sub');
}, 60_000);
