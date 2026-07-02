import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:assert strictEqual passes; throws ERR_ASSERTION on mismatch', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const assert = require('node:assert'); " +
    "let okErr = null; " +
    "try { assert.strictEqual(1, 1); } catch (e) { okErr = e; } " +
    "let failErr = null; " +
    "try { assert.strictEqual(1, 2); } catch (e) { failErr = e; } " +
    "process.stdout.write('A:okThrew=' + (okErr !== null) + '|failThrew=' + (failErr !== null) + '|code=' + (failErr && failErr.code) + '|name=' + (failErr && failErr.name) + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('A:okThrew=false|');
  expect(s).toContain('failThrew=true');
  expect(s).toContain('code=ERR_ASSERTION');
  expect(s).toContain('name=AssertionError');
}, 60_000);
