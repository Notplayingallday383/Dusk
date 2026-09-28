import { expect, test } from 'vitest';
import { bootRepl, type RelayListener, type RelaySocket } from '../src/index';

class DeterministicRelaySocket implements RelaySocket {
  readonly sent: Uint8Array[] = [];
  readonly closeReasons: Array<number | undefined> = [];
  private dataHandlers = new Set<(data: Uint8Array) => void>();
  private closeHandlers = new Set<(reason: number) => void>();

  onData(callback: (data: Uint8Array) => void): () => void {
    this.dataHandlers.add(callback);
    return () => this.dataHandlers.delete(callback);
  }

  onClose(callback: (reason: number) => void): () => void {
    this.closeHandlers.add(callback);
    return () => this.closeHandlers.delete(callback);
  }

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(reason?: number): void {
    this.closeReasons.push(reason);
  }

  receive(text: string): void {
    const data = new TextEncoder().encode(text);
    for (const callback of [...this.dataHandlers]) callback(data);
  }

  get listenerCount(): number {
    return this.dataHandlers.size + this.closeHandlers.size;
  }
}

class DeterministicRelayListener implements RelayListener {
  authorizeListen = (): boolean => true;
  readonly registrations: Array<{ host: string; port: number }> = [];
  readonly unregistrations: Array<{ host: string; port: number }> = [];
  private handlers = new Map<string, (socket: RelaySocket) => void>();

  registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void {
    const key = `${host}:${port}`;
    if (this.handlers.has(key)) throw new Error(`EADDRINUSE: address already in use ${key}`);
    this.registrations.push({ host, port });
    this.handlers.set(key, handler);
    return () => {
      if (!this.handlers.delete(key)) return;
      this.unregistrations.push({ host, port });
    };
  }

  connect(socket: RelaySocket, host = 'dusk.local', port = 8080): void {
    const handler = this.handlers.get(`${host}:${port}`);
    if (!handler) throw new Error('relay listener is not registered');
    handler(socket);
  }

  get listenerCount(): number {
    return this.handlers.size;
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error('timed out waiting for condition');
};

const text = (socket: DeterministicRelaySocket): string =>
  new TextDecoder().decode(concat(socket.sent));

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

test('/bin/node HTTP relay reuses an HTTP/1.1 socket until Connection: close', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "http.createServer((req, res) => res.end(req.url)).listen(8080, 'dusk.local');",
  ].join(' ')], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('GET /one HTTP/1.1\r\nHost: dusk.local\r\n\r\n');
    await waitFor(() => text(socket).includes('\r\n\r\n/one'));
    expect(socket.closeReasons).toEqual([]);
    expect(socket.listenerCount).toBe(2);

    const firstResponseLength = text(socket).length;
    socket.receive('GET /two HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await waitFor(() => text(socket).slice(firstResponseLength).includes('\r\n\r\n/two'));
    await waitFor(() => socket.closeReasons.length === 1);
    expect(socket.closeReasons).toEqual([undefined]);
    expect(socket.listenerCount).toBe(0);
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node HTTP relay frames streaming keep-alive responses as chunked', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "http.createServer((_req, res) => { res.write('one'); res.end('two'); }).listen(8080, 'dusk.local');",
  ].join(' ')], { cwd: '/root', env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' } });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\n\r\n');
    await waitFor(() => text(socket).includes('0\r\n\r\n'));
    expect(text(socket)).toContain('Transfer-Encoding: chunked\r\n\r\n3\r\none\r\n3\r\ntwo\r\n0\r\n\r\n');
    expect(socket.closeReasons).toEqual([]);
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node HTTP relay keeps HTTP/1.0 connections alive only when requested', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "http.createServer((req, res) => res.end(req.url)).listen(8080, 'dusk.local');",
  ].join(' ')], { cwd: '/root', env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' } });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('GET /one HTTP/1.0\r\nHost: dusk.local\r\nConnection: keep-alive\r\n\r\n');
    await waitFor(() => text(socket).includes('\r\n\r\n/one'));
    expect(socket.closeReasons).toEqual([]);
    socket.receive('GET /two HTTP/1.0\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await waitFor(() => text(socket).includes('\r\n\r\n/two') && socket.closeReasons.length === 1);
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node HTTP relay forces Connection: close when the request requires closure', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "http.createServer((_req, res) => { res.setHeader('Connection', 'keep-alive'); res.end('closed'); }).listen(8080, 'dusk.local');",
  ].join(' ')], { cwd: '/root', env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' } });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await waitFor(() => text(socket).includes('\r\n\r\nclosed') && socket.closeReasons.length === 1);
    expect(text(socket)).toContain('\r\nConnection: close\r\n');
    expect(text(socket)).not.toContain('Connection: keep-alive');
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node HTTP relay consumes chunked request trailers before the next pipelined request', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "http.createServer((req, res) => res.end(req.url)).listen(8080, 'dusk.local');",
  ].join(' ')], { cwd: '/root', env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' } });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('POST /first HTTP/1.1\r\nHost: dusk.local\r\nTransfer-Encoding: chunked\r\n\r\n3\r\nabc\r\n0\r\nX-Trailer: value\r\n\r\nGET /second HTTP/1.1\r\nHost: dusk.local\r\n\r\n');
    await waitFor(() => text(socket).includes('\r\n\r\n/first') && text(socket).includes('\r\n\r\n/second'));
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node HTTP relay suppresses bodyless response bytes before the next persistent request', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    'http.createServer((req, res) => {',
    "  if (req.method === 'HEAD') return res.end('head-body');",
    "  if (req.url === '/204') { res.statusCode = 204; return res.end('no-204'); }",
    "  if (req.url === '/304') { res.statusCode = 304; return res.end('no-304'); }",
    "  if (req.url === '/100') { res.statusCode = 100; return res.end('no-100'); }",
    "  res.end('next');",
    "}).listen(8080, 'dusk.local');",
  ].join(' ')], { cwd: '/root', env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' } });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('HEAD /head HTTP/1.1\r\nHost: dusk.local\r\n\r\nGET /204 HTTP/1.1\r\nHost: dusk.local\r\n\r\nGET /304 HTTP/1.1\r\nHost: dusk.local\r\n\r\nGET /100 HTTP/1.1\r\nHost: dusk.local\r\n\r\nGET /next HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await waitFor(() => text(socket).includes('\r\n\r\nnext'));
    expect(text(socket)).toMatch(/Content-Length: 9\r\n\r\nHTTP\/1\.1 204/);
    expect(text(socket)).not.toContain('head-body');
    expect(text(socket)).not.toContain('no-204');
    expect(text(socket)).not.toContain('no-304');
    expect(text(socket)).not.toContain('no-100');
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node HTTP relay serves concurrent requests and unregisters on server.close', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "const server = http.createServer((req, res) => { res.end(req.url); if (req.url === '/close') server.close(); });",
    "server.listen(8080, 'dusk.local');",
  ].join(' ')], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

  try {
    await waitFor(() => relay.listenerCount === 1);

    const first = new DeterministicRelaySocket();
    const second = new DeterministicRelaySocket();
    relay.connect(first);
    relay.connect(second);
    first.receive('GET /first HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    second.receive('GET /second HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await waitFor(() => text(first).includes('\r\n\r\n/first') && text(second).includes('\r\n\r\n/second'));

    const closing = new DeterministicRelaySocket();
    relay.connect(closing);
    closing.receive('GET /close HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
    await waitFor(() => relay.listenerCount === 0);
    expect(relay.unregistrations).toEqual([{ host: 'dusk.local', port: 8080 }]);
    expect(first.closeReasons).toEqual([undefined]);
    expect(second.closeReasons).toEqual([undefined]);
    expect(closing.closeReasons).toEqual([undefined]);
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(0);
    expect(closing.listenerCount).toBe(0);
    expect(await handle.exit).toBe(0);
  } finally {
    handle.kill();
  }
}, 60_000);

test('/bin/node process exit releases active relay listeners and sockets', async () => {
  const relay = new DeterministicRelayListener();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "const server = http.createServer((_req, res) => { res.end('exiting'); process.exit(0); });",
    "server.listen(8080, 'dusk.local');",
  ].join(' ')], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

  try {
    await waitFor(() => relay.listenerCount === 1);
    const socket = new DeterministicRelaySocket();
    relay.connect(socket);
    socket.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\n\r\n');

    expect(await handle.exit).toBe(0);
    expect(relay.listenerCount).toBe(0);
    expect(relay.unregistrations).toEqual([{ host: 'dusk.local', port: 8080 }]);
    expect(socket.closeReasons).toEqual([undefined]);
    expect(socket.listenerCount).toBe(0);
  } finally {
    handle.kill();
  }
}, 60_000);
