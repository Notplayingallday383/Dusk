import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// Note: plan's original test code used `new TextDecoder().decode(chunk)`, but
// TextDecoder is not defined in this SpiderMonkey engine build. Using
// `String(chunk)` instead — Buffer's toString override yields utf8 text.
test('node:http createServer + http.get loopback round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "(async () => { " +
    "const http = require('node:http'); " +
    "const PORT = 9301; " +
    "const server = http.createServer((req, res) => { res.statusCode = 200; res.end('hi-http'); }); " +
    "await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); " +
    "const body = await new Promise((resolve, reject) => { " +
    "  const req = http.get({ host: '127.0.0.1', port: PORT, path: '/' }, (res) => { " +
    "    const parts = []; " +
    "    res.on('data', (c) => parts.push(typeof c === 'string' ? c : String(c))); " +
    "    res.on('end', () => resolve(parts.join(''))); " +
    "  }); " +
    "  req.on('error', reject); " +
    "}); " +
    "server.close(); " +
    "process.stdout.write('H:body=' + body + ':END'); " +
    "})()\n"
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('H:body=hi-http:END');
}, 60_000);
