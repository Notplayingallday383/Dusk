import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:crypto randomBytes, sha256(hello), hmac sha1, timingSafeEqual, randomUUID', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const crypto = require('node:crypto'); " +
    "const rb = crypto.randomBytes(16); " +
    "const sha = crypto.createHash('sha256').update('hello').digest('hex'); " +
    "const hmac = crypto.createHmac('sha1', 'key').update('msg').digest('hex'); " +
    "const a = new Uint8Array([1,2,3,4]); const b = new Uint8Array([1,2,3,4]); " +
    "const eq = crypto.timingSafeEqual(a, b); " +
    "const c = new Uint8Array([1,2,3,5]); const neq = crypto.timingSafeEqual(a, c); " +
    "const uuid = crypto.randomUUID(); " +
    "process.stdout.write('C:rbLen=' + rb.length + '|sha=' + sha + '|hmacLen=' + hmac.length + '|eq=' + eq + '|neq=' + neq + '|uuidLen=' + uuid.length + '|uuidShape=' + /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid) + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('C:rbLen=16|');
  expect(s).toContain('sha=2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  expect(s).toContain('hmacLen=40');
  expect(s).toContain('eq=true');
  expect(s).toContain('neq=false');
  expect(s).toContain('uuidLen=36');
  expect(s).toContain('uuidShape=true');
}, 60_000);
