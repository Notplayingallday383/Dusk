import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:buffer Buffer.from string, readUInt8, concat, alloc zero-fill, base64 round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const { Buffer } = require('node:buffer'); " +
    "const a = Buffer.from('AB'); " +
    "const b0 = a.readUInt8(0); const b1 = a.readUInt8(1); " +
    "const c = Buffer.concat([Buffer.from('hi-'), Buffer.from('there')]); " +
    "const z = Buffer.alloc(4); " +
    "const zsum = z[0] + z[1] + z[2] + z[3]; " +
    "const b64 = Buffer.from('hello').toString('base64'); " +
    "const back = Buffer.from(b64, 'base64').toString('utf8'); " +
    "process.stdout.write('B:b0=' + b0 + '|b1=' + b1 + '|concat=' + c.toString('utf8') + '|zlen=' + z.length + '|zsum=' + zsum + '|b64=' + b64 + '|back=' + back + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('B:b0=65|b1=66|');
  expect(s).toContain('concat=hi-there');
  expect(s).toContain('zlen=4');
  expect(s).toContain('zsum=0');
  expect(s).toContain('b64=aGVsbG8=');
  expect(s).toContain('back=hello');
}, 60_000);
