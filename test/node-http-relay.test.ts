import { expect, test } from 'vitest';
import { bootRepl, type RelayListener, type RelaySocket } from '../src/index';

class FakeRelaySocket implements RelaySocket {
  sent: Uint8Array[] = [];
  closeReasons: Array<number | undefined> = [];
  private dataHandlers = new Set<(data: Uint8Array) => void>();
  private closeHandlers = new Set<(reason: number) => void>();

  onData(cb: (data: Uint8Array) => void): () => void {
    this.dataHandlers.add(cb);
    return () => this.dataHandlers.delete(cb);
  }

  onClose(cb: (reason: number) => void): () => void {
    this.closeHandlers.add(cb);
    return () => this.closeHandlers.delete(cb);
  }

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(reason?: number): void {
    this.closeReasons.push(reason);
  }

  triggerClose(reason: number): void {
    for (const cb of [...this.closeHandlers]) cb(reason);
  }

  get listenerCount(): number {
    return this.dataHandlers.size + this.closeHandlers.size;
  }

  receive(text: string): void {
    const data = new TextEncoder().encode(text);
    for (const cb of [...this.dataHandlers]) cb(data);
  }
}

class FakeRelay implements RelayListener {
  registrations: Array<{ host: string; port: number }> = [];
  disposed = 0;
  private handlers = new Map<string, (socket: RelaySocket) => void>();

  registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void {
    const key = `${host}:${port}`;
    if (this.handlers.has(key)) throw new Error(`EADDRINUSE: address already in use ${key}`);
    this.registrations.push({ host, port });
    this.handlers.set(key, handler);
    return () => {
      this.disposed++;
      this.handlers.delete(key);
    };
  }

  connect(socket: RelaySocket, host = 'dusk.local', port = 8080): void {
    const handler = this.handlers.get(`${host}:${port}`);
    if (!handler) throw new Error('relay listener is not registered');
    handler(socket);
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!predicate()) throw new Error('timed out waiting for condition');
};

test('node:http mirrors a named listener into the relay and bridges inbound bytes', async () => {
  const relay = new FakeRelay();
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory', net: { relay } });

  try {
    await repl.feed([
      "const http = require('node:http');",
      "const server = http.createServer((_req, res) => { res.end('relay-ok'); server.close(); });",
      "server.listen(8080, 'dusk.local', () => {",
      "  const a = server.address();",
      "  process.stdout.write('ADDR=' + a.address + ':' + a.port + ':READY');",
      '});',
      '',
    ].join(' '));

    await waitFor(() => relay.registrations.length === 1 && out.join('').includes(':READY'));
    expect(relay.registrations).toEqual([{ host: 'dusk.local', port: 8080 }]);
    expect(out.join('')).toContain('ADDR=dusk.local:8080:READY');

    const socket = new FakeRelaySocket();
    relay.connect(socket);
    socket.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');

    await waitFor(() => new TextDecoder().decode(concat(socket.sent)).includes('relay-ok'));
    const response = new TextDecoder().decode(concat(socket.sent));
    expect(response).toMatch(/^HTTP\/1\.1 200 OK\r\n/);
    expect(response).toContain('Content-Length: 8\r\n');
    expect(response).toContain('\r\n\r\nrelay-ok');
    await waitFor(() => relay.disposed === 1 && socket.closeReasons.length === 1);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('two Dusk HTTP servers on the same relay address surface EADDRINUSE', async () => {
  const relay = new FakeRelay();
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory', net: { relay } });

  try {
    await repl.feed([
      "const http = require('node:http');",
      'const first = http.createServer();',
      'const second = http.createServer();',
      "second.once('error', (error) => { process.stdout.write('ERROR=' + error.code + ':END'); first.close(); });",
      "first.listen(8081, 'dusk.local', () => second.listen(8081, 'dusk.local'));",
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes(':END'));
    expect(out.join('')).toContain('ERROR=EADDRINUSE:END');
    expect(relay.registrations.filter(({ host, port }) => host === 'dusk.local' && port === 8081)).toHaveLength(1);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('remote relay close cleans up once and maps a close reason to end, not error', async () => {
  const relay = new FakeRelay();
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory', net: { relay } });

  try {
    await repl.feed([
      "const net = require('node:net');",
      'const server = net.createServer((socket) => {',
      "  socket.on('end', () => process.stdout.write('REMOTE_END'));",
      "  socket.on('error', () => process.stdout.write('REMOTE_ERROR'));",
      "  process.stdout.write('CONNECTED');",
      '});',
      "server.listen(8083, 'dusk.local');",
      '',
    ].join(' '));
    await waitFor(() => relay.registrations.some(({ port }) => port === 8083));

    const socket = new FakeRelaySocket();
    relay.connect(socket, 'dusk.local', 8083);
    await waitFor(() => out.join('').includes('CONNECTED'));
    socket.triggerClose(73);
    socket.triggerClose(99);
    await waitFor(() => out.join('').includes('REMOTE_END'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(out.join('').match(/REMOTE_END/g)).toHaveLength(1);
    expect(out.join('')).not.toContain('REMOTE_ERROR');
    expect(socket.listenerCount).toBe(0);
    expect(socket.closeReasons).toEqual([]);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('server unlisten disposes its relay listener and closes an active socket once', async () => {
  const relay = new FakeRelay();
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory', net: { relay } });

  try {
    await repl.feed([
      "const net = require('node:net');",
      'const server = net.createServer(() => {',
      "  process.stdout.write('CONNECTED');",
      '  server.close();',
      '});',
      "server.listen(8084, 'dusk.local');",
      '',
    ].join(' '));
    await waitFor(() => relay.registrations.some(({ port }) => port === 8084));

    const socket = new FakeRelaySocket();
    relay.connect(socket, 'dusk.local', 8084);
    await waitFor(() => out.join('').includes('CONNECTED') && relay.disposed === 1);

    expect(socket.closeReasons).toEqual([undefined]);
    expect(socket.listenerCount).toBe(0);
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('server close releases the address for a replacement listener', async () => {
  const relay = new FakeRelay();
  const out: string[] = [];
  const repl = await bootRepl((text) => out.push(text), { fs: 'memory', net: { relay } });

  try {
    await repl.feed([
      "const http = require('node:http');",
      "const first = http.createServer();",
      "first.listen(8085, 'dusk.local', () => first.close(() => {",
      "  const second = http.createServer();",
      "  second.once('error', (error) => process.stdout.write('ERROR=' + error.code + ':END'));",
      "  second.listen(8085, 'dusk.local', () => process.stdout.write('REBOUND:END'));",
      "}));",
      '',
    ].join(' '));
    await waitFor(() => out.join('').includes(':END'));
    expect(out.join('')).toContain('REBOUND:END');
    expect(out.join('')).not.toContain('ERROR=EADDRINUSE');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('process cleanup disposes relay listeners and active inbound sockets', async () => {
  const relay = new FakeRelay();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay } });
  let terminated = false;

  try {
    await repl.feed([
      "const net = require('node:net');",
      "net.createServer(() => {}).listen(8082, 'dusk.local');",
      '',
    ].join(' '));
    await waitFor(() => relay.registrations.some(({ port }) => port === 8082));

    const socket = new FakeRelaySocket();
    relay.connect(socket, 'dusk.local', 8082);
    await repl.engine.terminate();
    terminated = true;

    expect(relay.disposed).toBe(1);
    expect(socket.closeReasons).toEqual([undefined]);
    expect(socket.listenerCount).toBe(0);
  } finally {
    if (!terminated) await repl.engine.terminate();
  }
}, 60_000);

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
