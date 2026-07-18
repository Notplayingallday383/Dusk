import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// Note: plan's original test code used `new TextDecoder().decode(chunk)`, but
// TextDecoder is not defined in this SpiderMonkey engine build. Using
// `String(chunk)` instead — Buffer's toString override yields utf8 text.
test('node:net loopback Server + Socket echo round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "(async () => { " +
    "const net = require('node:net'); " +
    "const PORT = 9300; " +
    "const server = net.createServer((sock) => { " +
    "  sock.on('data', (chunk) => { sock.write(chunk); }); " +
    "  sock.on('end', () => { sock.end(); }); " +
    "}); " +
    "await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); " +
    "const client = net.connect({ host: '127.0.0.1', port: PORT }); " +
    "client.on('data', (chunk) => { " +
    "  process.stdout.write('N:got=' + String(chunk) + ':END'); " +
    "  client.end(); server.close(); " +
    "}); " +
    "client.once('connect', () => client.write('ping-net')); " +
    "})()\n"
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('N:got=ping-net:END');
}, 60_000);

test('node:net listen(0) reports unique deterministic ephemeral ports', async () => {
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory' });
  try {
    await repl.feed([
      "const net = require('node:net');",
      'const first = net.createServer();',
      'const second = net.createServer();',
      "first.listen(0, '127.0.0.1', () => {",
      "  second.listen(0, '127.0.0.1', () => {",
      '    const a = first.address(); const b = second.address();',
      "    process.stdout.write('EPHEMERAL=' + a.address + ':' + a.port + ',' + b.address + ':' + b.port + ':END');",
      '    first.close(); second.close();',
      '  });',
      '});',
      '',
    ].join(' '));

    const deadline = Date.now() + 10_000;
    while (!out.join('').includes(':END') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const match = /EPHEMERAL=127\.0\.0\.1:(\d+),127\.0\.0\.1:(\d+):END/.exec(out.join(''));
    expect(match).not.toBeNull();
    const firstPort = Number(match?.[1]);
    const secondPort = Number(match?.[2]);
    expect(firstPort).toBeGreaterThanOrEqual(49_152);
    expect(firstPort).toBeLessThanOrEqual(65_535);
    expect(secondPort).toBe(firstPort + 1);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);
