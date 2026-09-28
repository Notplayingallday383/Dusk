import { WispClient, type WispStream } from '@nightnetwork/moonbeam';

export interface TcpStream {
  /** Set only after a TLS provider has completed certificate validation. */
  tls?: { verified: boolean };
  write(data: Uint8Array): void;
  end(): void;
  close(): void;
  onData(callback: (data: Uint8Array) => void): void;
  onEnd(callback: () => void): void;
  onError(callback: (error: unknown) => void): void;
}

export interface TcpOpenOptions {
  /** Request a TLS stream rather than raw Wisp TCP. */
  tls?: boolean;
  /** TLS SNI name and certificate hostname. Defaults to the dial host. */
  servername?: string;
  /** TLS ALPN protocol advertisements. */
  alpnProtocols?: string[];
}

export interface TcpProvider {
  open(host: string, port: number, options?: TcpOpenOptions): Promise<TcpStream>;
}

export interface TcpRelayAttachment {
  attach(metadata?: { label?: string }): MessagePort;
}

export const createTcpProvider = (provider: TcpProvider): TcpProvider => provider;

class RelayWebSocket {
  binaryType = 'arraybuffer';
  private listeners = new Map<string, Set<(event?: MessageEvent) => void>>();

  constructor(private readonly port: MessagePort) {
    port.addEventListener('message', (event) => this.emit('message', event));
    port.start();
    queueMicrotask(() => this.emit('open'));
  }

  addEventListener(event: string, listener: (event?: MessageEvent) => void): void {
    let listeners = this.listeners.get(event);
    if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
    listeners.add(listener);
  }

  send(data: Uint8Array): void {
    const copy = data.slice();
    this.port.postMessage(copy.buffer, [copy.buffer]);
  }

  close(): void { this.port.close(); this.emit('close'); }

  private emit(event: string, payload?: MessageEvent): void {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }
}

const fromWispStream = (stream: WispStream): TcpStream => {
  let onData: (data: Uint8Array) => void = () => {};
  let onEnd: () => void = () => {};
  let onError: (error: unknown) => void = () => {};
  stream.on('data', (data: Uint8Array) => onData(data));
  stream.on('close', () => onEnd());
  stream.on('error', (error: unknown) => onError(error));
  return {
    write: (data) => stream.send(data),
    end: () => stream.close(),
    close: () => stream.close(),
    onData: (callback) => { onData = callback; },
    onEnd: (callback) => { onEnd = callback; },
    onError: (callback) => { onError = callback; },
  };
};

export const createWispTcpProvider = (options: { proxyUrl?: string; relay?: TcpRelayAttachment }): TcpProvider => {
  if (!options.proxyUrl && !options.relay) throw new Error('TCP provider requires a Wisp URL or relay');
  let client: WispClient | undefined;
  const getClient = async (): Promise<WispClient> => {
    if (!client) {
      client = options.relay
        ? new WispClient({ url: 'moonbeam://relay', _injectWebSocket: new RelayWebSocket(options.relay.attach({ label: 'dusk-tcp' })) })
        : new WispClient({ url: options.proxyUrl! });
    }
    await client.ready();
    return client;
  };
  return createTcpProvider({
    open: async (host, port, openOptions) => {
      if (openOptions?.tls) throw new Error('raw Wisp TCP cannot satisfy a TLS request');
      return fromWispStream((await getClient()).createStream(host, port, 'tcp'));
    },
  });
};

interface NovaTlsSocket {
  onopen: (() => void) | null;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  send(data: Uint8Array): void;
  close(): void;
}

interface NovaTlsLibcurl {
  load_wasm(): Promise<void>;
  set_websocket(url: string): void;
  TLSSocket?: new (host: string, port: number, options?: TcpOpenOptions) => NovaTlsSocket;
}

export interface WispTlsTcpProviderOptions {
  /** The Wisp or MoonBeam WebSocket route used by Nova. */
  proxyUrl: string;
  /** Loads the Nova LibCurl instance that owns the Rustls TLS client. */
  loadLibcurl: () => Promise<NovaTlsLibcurl>;
  /** Optional raw TCP provider. Defaults to a Wisp provider for this route. */
  tcpProvider?: TcpProvider;
}

/**
 * Hybrid Dusk transport: raw requests use Wisp TCP; TLS requests use Nova's
 * Rustls client over the same configured Wisp/MoonBeam route. Nova validates
 * the certificate chain and the SNI hostname before firing `onopen`.
 */
export const createWispTlsTcpProvider = (options: WispTlsTcpProviderOptions): TcpProvider => {
  const raw = options.tcpProvider ?? createWispTcpProvider({ proxyUrl: options.proxyUrl });
  let loading: Promise<NovaTlsLibcurl> | undefined;
  const getNova = (): Promise<NovaTlsLibcurl> => {
    if (!loading) {
      loading = (async () => {
        const nova = await options.loadLibcurl();
        await nova.load_wasm();
        nova.set_websocket(options.proxyUrl);
        if (!nova.TLSSocket) throw new Error('Nova TLS socket support is unavailable');
        return nova;
      })().catch((error) => {
        loading = undefined;
        throw error;
      });
    }
    return loading;
  };

  return createTcpProvider({
    open: async (host, port, openOptions) => {
      if (!openOptions?.tls) return raw.open(host, port, openOptions);
      const nova = await getNova();
      const servername = openOptions.servername ?? host;
      const tlsOptions: TcpOpenOptions = {
        servername,
        ...(openOptions.alpnProtocols ? { alpnProtocols: [...openOptions.alpnProtocols] } : {}),
      };
      return new Promise<TcpStream>((resolve, reject) => {
        let connected = false;
        let data: (data: Uint8Array) => void = () => {};
        let ended: () => void = () => {};
        let failed: (error: unknown) => void = () => {};
        let socket: NovaTlsSocket;
        const fail = (error: unknown): void => {
          if (!connected) {
            reject(error instanceof Error ? error : new Error(String(error)));
            return;
          }
          failed(error);
        };
        try {
          socket = new nova.TLSSocket!(host, port, tlsOptions);
          socket.onopen = () => {
            if (connected) return;
            connected = true;
            resolve({
              tls: { verified: true },
              write: (bytes) => socket.send(bytes),
              end: () => socket.close(),
              close: () => socket.close(),
              onData: (callback) => { data = callback; },
              onEnd: (callback) => { ended = callback; },
              onError: (callback) => { failed = callback; },
            });
          };
          socket.onmessage = (bytes) => data(bytes);
          socket.onclose = () => {
            if (!connected) fail(new Error('TLS socket closed before certificate verification'));
            else ended();
          };
          socket.onerror = fail;
        } catch (error) {
          fail(error);
        }
      });
    },
  });
};
