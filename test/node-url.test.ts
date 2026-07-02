import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// SpiderMonkey engine lacks global URL/URLSearchParams — see src/world/node-url.ts:6 (falls back to 'URL not available' constructor)
test.skip('node:url URL parse + URLSearchParams round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const { URL, URLSearchParams } = require('node:url'); " +
    "const u = new URL('https://example.com:8443/p/q?x=1&y=two#frag'); " +
    "const sp = new URLSearchParams(); sp.set('a', '1'); sp.set('b', 'hello world'); sp.append('c', 'x'); sp.append('c', 'y'); " +
    "const qs = sp.toString(); " +
    "const sp2 = new URLSearchParams(qs); " +
    "process.stdout.write('U:host=' + u.host + '|hostname=' + u.hostname + '|port=' + u.port + '|path=' + u.pathname + '|search=' + u.search + '|hash=' + u.hash + '|qs=' + qs + '|a=' + sp2.get('a') + '|b=' + sp2.get('b') + '|cAll=' + sp2.getAll('c').join(',') + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('host=example.com:8443');
  expect(s).toContain('hostname=example.com');
  expect(s).toContain('port=8443');
  expect(s).toContain('path=/p/q');
  expect(s).toContain('search=?x=1&y=two');
  expect(s).toContain('hash=#frag');
  expect(s).toContain('a=1');
  expect(s).toContain('b=hello world');
  expect(s).toContain('cAll=x,y');
}, 60_000);
