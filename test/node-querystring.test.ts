import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:querystring stringify/parse round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const qs = require('node:querystring'); " +
    "const s = qs.stringify({ a: '1', b: 'hello world', c: ['x', 'y'] }); " +
    "const p = qs.parse(s); " +
    "process.stdout.write('Q:s=' + s + '|a=' + p.a + '|b=' + p.b + '|cIsArr=' + Array.isArray(p.c) + '|c=' + (Array.isArray(p.c) ? p.c.join(',') : p.c) + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('Q:s=a=1&b=hello%20world&c=x&c=y');
  expect(s).toContain('a=1');
  expect(s).toContain('b=hello world');
  expect(s).toContain('cIsArr=true');
  expect(s).toContain('c=x,y');
}, 60_000);
