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

test('node:http loopback reuses an HTTP/1.1 socket until Connection: close', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed([
    "const http = require('node:http');",
    "const net = require('node:net');",
    "const server = http.createServer((req, res) => res.end(req.url));",
    "server.listen(9302, '127.0.0.1', () => {",
    "  const socket = net.createConnection({ host: '127.0.0.1', port: 9302 });",
    "  let received = '';",
    "  socket.on('connect', () => socket.write('GET /one HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n'));",
    "  socket.on('data', (chunk) => {",
    "    received += String(chunk);",
    "    if (received.includes('\\r\\n\\r\\n/one') && !received.includes('\\r\\n\\r\\n/two')) socket.write('GET /two HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n');",
    "    if (received.includes('\\r\\n\\r\\n/two')) { server.close(); process.stdout.write('KEEP=' + received + ':END'); }",
    "  });",
    "});",
    '',
  ].join(' '));
  const deadline = Date.now() + 10_000;
  while (!out.join('').includes(':END') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  repl.engine.terminate();
  expect(out.join('')).toContain('\r\n\r\n/one');
  expect(out.join('')).toContain('\r\n\r\n/two');
}, 60_000);

test('node:http client ends an empty keep-alive response with Content-Length: 0', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed([
    "const http = require('node:http');",
    "const server = http.createServer((_req, res) => res.end());",
    "server.listen(9303, '127.0.0.1', () => {",
    "  http.get({ host: '127.0.0.1', port: 9303 }, (res) => {",
    "    res.on('end', () => { server.close(); process.stdout.write('EMPTY=' + res.headers['content-length'] + ':END'); });",
    "  });",
    "});",
    '',
  ].join(' '));
  const deadline = Date.now() + 10_000;
  while (!out.join('').includes(':END') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  repl.engine.terminate();
  expect(out.join('')).toContain('EMPTY=0:END');
}, 60_000);

test('node:http loopback suppresses a HEAD body before a pipelined response', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed([
    "const http = require('node:http');",
    "const net = require('node:net');",
    "const server = http.createServer((req, res) => { if (req.method === 'HEAD') res.end('head-body'); else { res.end('next'); server.close(); } });",
    "server.listen(9304, '127.0.0.1', () => {",
    "  const socket = net.createConnection({ host: '127.0.0.1', port: 9304 });",
    "  let received = '';",
    "  socket.on('connect', () => socket.write('HEAD /head HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\nGET /next HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n'));",
    "  socket.on('data', (chunk) => { received += String(chunk); if (received.includes('\\r\\n\\r\\nnext')) process.stdout.write('BODYLESS=' + received + ':END'); });",
    "});",
    '',
  ].join(' '));
  const deadline = Date.now() + 10_000;
  while (!out.join('').includes(':END') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  repl.engine.terminate();
  expect(out.join('')).toMatch(/Content-Length: 9\r\n\r\nHTTP\/1\.1 200/);
  expect(out.join('')).not.toContain('head-body');
  expect(out.join('')).toContain('\r\n\r\nnext');
}, 60_000);
