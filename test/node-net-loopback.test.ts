import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import type { TcpStream } from '../src/host/tcp';

class GuestTcpStream implements TcpStream {
  private endHandler: (() => void) | undefined;
  write(_data: Uint8Array): void {}
  end(): void { this.endHandler?.(); }
  close(): void {}
  onData(_callback: (data: Uint8Array) => void): void {}
  onEnd(callback: () => void): void { this.endHandler = callback; }
  onError(_callback: (error: unknown) => void): void {}
}

test('node:net waits for host outbound TCP connect dispatch', async () => {
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), {
    fs: 'memory',
    net: { tcpProvider: { open: async () => new GuestTcpStream() } },
  });
  try {
    await repl.feed([
      "const net = require('node:net');",
      "const client = net.connect({ host: 'ssh.example.test', port: 22 });",
      "client.once('connect', () => { process.stdout.write('TCP-GUEST=' + client.remoteAddress + ':' + client.remotePort + ':END'); client.end(); });",
      '',
    ].join(' '));
    const deadline = Date.now() + 10_000;
    while (!out.join('').includes(':END') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(out.join('')).toContain('TCP-GUEST=ssh.example.test:22:END');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

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
