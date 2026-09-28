import { expect, test } from 'vitest';
import { bootRepl, createRelayTlsServer, type RelayListener, type RelaySocket, type TlsServerConnection } from '../src/index';
import { HttpParser } from '../src/world/http-parser';

class Socket implements RelaySocket {
  sent: Uint8Array[] = [];
  data = new Set<(data: Uint8Array) => void>();
  closed = new Set<(reason: number) => void>();
  onData(cb: (data: Uint8Array) => void): () => void { this.data.add(cb); return () => this.data.delete(cb); }
  onClose(cb: (reason: number) => void): () => void { this.closed.add(cb); return () => this.closed.delete(cb); }
  send(data: Uint8Array): void { this.sent.push(data.slice()); }
  close(): void { for (const cb of [...this.closed]) cb(0); }
  receive(data: number[]): void { for (const cb of [...this.data]) cb(Uint8Array.from(data)); }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  if (!predicate()) throw new Error('timed out waiting for condition');
};

test('public HTTPS server handles a relay TLS handshake then an HTTP/1.1 request', async () => {
  let handler!: (socket: RelaySocket) => void;
  const relay: RelayListener = { registerListener: (_host, _port, next) => { handler = next; return () => {}; } };
  class Connection implements TlsServerConnection {
    onciphertext: ((data: Uint8Array) => void) | null = null;
    onplaintext: ((data: Uint8Array) => void) | null = null;
    onsecure: (() => void) | null = null;
    onerror: ((error: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    private secure = false;
    acceptCiphertext(data: Uint8Array): void {
      if (!this.secure) { this.secure = true; this.onsecure?.(); return; }
      this.onplaintext?.(data);
    }
    writePlaintext(data: Uint8Array): void { this.onciphertext?.(data); }
    close(): void { this.onend?.(); }
  }
  const output: string[] = [];
  const repl = await bootRepl((text) => output.push(text), {
    fs: 'memory',
    net: { relay, relayTls: { Connection, authorize: (request) => request.hostname === 'public.test' && request.port === 443 && request.tls } },
  });
  try {
    await repl.feed("const https = require('https'); const server = https.createServer({ cert: 'cert', key: 'key' }, (req, res) => res.end('ok')); server.on('secureConnection', () => process.stdout.write('SECURE:')); server.listen(443, 'public.test', () => process.stdout.write('LISTEN:'));");
    await waitFor(() => output.join('').includes('LISTEN:'));
    const socket = new Socket();
    handler(socket);
    socket.receive([1]);
    await waitFor(() => output.join('').includes('SECURE:'));
    socket.receive([...new TextEncoder().encode('GET /relay HTTP/1.1\r\nHost: public.test\r\n\r\n')]);
    await waitFor(() => socket.sent.length > 0);
    expect(output.join('')).toContain('SECURE:');
    const response = socket.sent.map((chunk) => new TextDecoder().decode(chunk)).join('');
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(response).toContain('ok');
  } finally {
    await repl.engine.terminate();
  }
}, 60_000);

test('relay TLS adaptor only exposes a decrypted socket after the handshake and composes with HTTP/1.1', () => {
  let handler!: (socket: RelaySocket) => void;
  const relay: RelayListener = { registerListener: (_host, _port, next) => { handler = next; return () => {}; } };
  let connection!: TlsServerConnection;
  const requests: string[] = [];
  const server = createRelayTlsServer(relay, {
    host: 'tls.test', port: 443, pid: 41, certificateChain: 'test cert', privateKey: 'test key',
    authorize: (request) => request.hostname === 'tls.test' && request.port === 443 && request.pid === 41 && request.tls,
    onSecureConnection: (socket) => {
      const parser = new HttpParser('REQUEST');
      parser.onHeadersComplete = (info) => {
        requests.push(`${info.method} ${info.url}`);
        socket.write(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok'));
      };
      socket.onData((data) => parser.execute(data));
    },
    Connection: class {
      onciphertext: ((data: Uint8Array) => void) | null = null;
      onplaintext: ((data: Uint8Array) => void) | null = null;
      onsecure: (() => void) | null = null;
      onerror: ((error: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      constructor() { connection = this; }
      acceptCiphertext(data: Uint8Array): void { this.onsecure?.(); this.onplaintext?.(data); }
      writePlaintext(data: Uint8Array): void { this.onciphertext?.(data); }
      close(): void { this.onend?.(); }
    },
  });
  const socket = new Socket();
  handler(socket);
  socket.receive([...new TextEncoder().encode('GET /ready HTTP/1.1\r\nHost: tls.test\r\n\r\n')]);
  expect(requests).toEqual(['GET /ready']);
  expect(new TextDecoder().decode(socket.sent[0])).toContain('HTTP/1.1 200 OK');
  expect(connection).toBeDefined();
  socket.close();
  expect(socket.data.size + socket.closed.size).toBe(0);
  server.close();
});

test('relay TLS adaptor rejects an absent TLS capability and unauthorized registrations', () => {
  const relay: RelayListener = { registerListener: () => { throw new Error('must not register'); } };
  expect(() => createRelayTlsServer(relay, {
    host: 'tls.test', port: 443, pid: 1, certificateChain: 'cert', privateKey: 'key',
    authorize: () => true,
    Connection: undefined as unknown as new () => TlsServerConnection,
  })).toThrow('Nova TLS server capability is not supported by the active relay host');
  expect(() => createRelayTlsServer(relay, {
    host: 'tls.test', port: 443, pid: 1, certificateChain: 'cert', privateKey: 'key',
    authorize: () => false,
    Connection: class { onciphertext = null; onplaintext = null; onsecure = null; onerror = null; onend = null; acceptCiphertext(): void {} writePlaintext(): void {} close(): void {} },
  })).toThrow('relay listen authorization denied');
});

test('a malformed TLS handshake never creates an HTTP connection', () => {
  let handler!: (socket: RelaySocket) => void;
  const relay: RelayListener = { registerListener: (_host, _port, next) => { handler = next; return () => {}; } };
  let httpConnections = 0;
  let tlsErrors = 0;
  const server = createRelayTlsServer(relay, {
    host: 'tls.test', port: 443, pid: 2, certificateChain: 'cert', privateKey: 'key', authorize: () => true,
    onSecureConnection: () => { httpConnections++; },
    onTlsClientError: () => { tlsErrors++; },
    Connection: class {
      onciphertext = null; onplaintext = null; onsecure = null; onerror: ((error: unknown) => void) | null = null; onend = null;
      acceptCiphertext(): void { this.onerror?.(new Error('malformed handshake')); }
      writePlaintext(): void {}
      close(): void {}
    },
  });
  const socket = new Socket();
  handler(socket);
  socket.receive([0xff]);
  expect(httpConnections).toBe(0);
  expect(tlsErrors).toBe(1);
  expect(socket.data.size + socket.closed.size).toBe(0);
  server.close();
});

test('relay TLS adaptor ignores late events after a connection error', () => {
  let handler!: (socket: RelaySocket) => void;
  const relay: RelayListener = { registerListener: (_host, _port, next) => { handler = next; return () => {}; } };
  let connection!: TlsServerConnection;
  createRelayTlsServer(relay, { host: 'tls.test', port: 443, pid: 3, certificateChain: 'cert', privateKey: 'key', authorize: () => true, Connection: class {
    onciphertext: ((data: Uint8Array) => void) | null = null; onplaintext = null; onsecure = null; onerror: ((error: unknown) => void) | null = null; onend = null;
    constructor() { connection = this; } acceptCiphertext(): void {} writePlaintext(): void {} close(): void {}
  } });
  const socket = new Socket(); handler(socket);
  connection.onerror?.(new Error('relay failure'));
  connection.onciphertext?.(Uint8Array.from([7]));
  expect(socket.sent).toEqual([]);
  expect(socket.data.size + socket.closed.size).toBe(0);
});
