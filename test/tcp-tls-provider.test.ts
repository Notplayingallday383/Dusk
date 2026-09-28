import { expect, test } from 'vitest';
import { createWispTlsTcpProvider } from '../src/host/tcp';
import { bootRepl } from '../src/index';

class FakeNovaTlsSocket {
  static sockets: FakeNovaTlsSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readonly writes: Uint8Array[] = [];

  constructor(readonly host: string, readonly port: number, readonly options: unknown) {
    FakeNovaTlsSocket.sockets.push(this);
  }

  send(data: Uint8Array): void { this.writes.push(data); }
  close(): void { this.onclose?.(); }
}

const waitForSocket = async (count: number): Promise<void> => {
  for (let attempt = 0; attempt < 20 && FakeNovaTlsSocket.sockets.length < count; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(FakeNovaTlsSocket.sockets).toHaveLength(count);
};

test('Nova TLS provider configures its Wisp route, forwards SNI and ALPN, and marks only an opened stream verified', async () => {
  let loaded = 0;
  const routes: string[] = [];
  const provider = createWispTlsTcpProvider({
    proxyUrl: 'wss://moonbeam.example/wisp/',
    loadLibcurl: async () => ({
      load_wasm: async () => { loaded++; },
      set_websocket: (url: string) => { routes.push(url); },
      TLSSocket: FakeNovaTlsSocket,
    }),
  });

  const opened = provider.open('origin.example', 443, {
    tls: true,
    servername: 'cdn.example',
    alpnProtocols: ['h2', 'http/1.1'],
  });
  await waitForSocket(1);

  const raw = FakeNovaTlsSocket.sockets[0]!;
  expect(loaded).toBe(1);
  expect(routes).toEqual(['wss://moonbeam.example/wisp/']);
  expect([raw.host, raw.port, raw.options]).toEqual([
    'origin.example',
    443,
    { servername: 'cdn.example', alpnProtocols: ['h2', 'http/1.1'] },
  ]);

  raw.onopen?.();
  const stream = await opened;
  expect(stream.tls).toEqual({ verified: true });
});

test('Nova TLS provider rejects handshake failures without exposing a stream', async () => {
  const provider = createWispTlsTcpProvider({
    proxyUrl: 'wss://moonbeam.example/wisp/',
    loadLibcurl: async () => ({
      load_wasm: async () => {},
      set_websocket: () => {},
      TLSSocket: FakeNovaTlsSocket,
    }),
  });

  const failed = provider.open('origin.example', 443, { tls: true });
  await waitForSocket(2);
  FakeNovaTlsSocket.sockets.at(-1)!.onerror?.(new Error('certificate rejected'));
  await expect(failed).rejects.toThrow('certificate rejected');
});

test('Dusk exposes a TLS-capable provider for its configured Nova route', async () => {
  const repl = await bootRepl(() => {}, {
    fs: 'memory',
    skipPidZero: true,
    net: {
      proxyUrl: 'wss://moonbeam.example/wisp/',
      loadLibcurl: async () => ({
        load_wasm: async () => {},
        set_websocket: () => {},
        TLSSocket: FakeNovaTlsSocket,
        fetch: async () => new Response(),
        WebSocket,
      }),
    },
  });

  expect(repl.tcpProvider).toBeDefined();
  repl.processManager.close();
});
