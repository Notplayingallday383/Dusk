import type { RelayListener, RelaySocket } from './process-manager';

export interface TlsServerConnection {
  onciphertext: ((data: Uint8Array) => void) | null;
  onplaintext: ((data: Uint8Array) => void) | null;
  onsecure: (() => void) | null;
  onerror: ((error: unknown) => void) | null;
  onend: (() => void) | null;
  acceptCiphertext(data: Uint8Array): void;
  writePlaintext(data: Uint8Array): void;
  close(): void;
}

export interface RelayListenRequest {
  hostname: string;
  port: number;
  pid: number;
  tls: boolean;
}

export type RelayListenAuthorizer = (request: RelayListenRequest) => boolean;

export interface RelayTlsPlaintextSocket {
  onData(callback: (data: Uint8Array) => void): () => void;
  onClose(callback: () => void): () => void;
  write(data: Uint8Array): void;
  close(): void;
}

export interface RelayTlsServerOptions {
  host: string;
  port: number;
  pid: number;
  certificateChain: string | Uint8Array;
  privateKey: string | Uint8Array;
  Connection: new (certificateChain: string | Uint8Array, privateKey: string | Uint8Array, options?: unknown) => TlsServerConnection;
  authorize: RelayListenAuthorizer;
  onSecureConnection?: (socket: RelayTlsPlaintextSocket) => void;
  onTlsClientError?: (error: Error) => void;
}

export interface RelayTlsServer { close(): void; }

// This is intentionally a host capability, not a node:tls server surface.
export const createRelayTlsServer = (relay: RelayListener, options: RelayTlsServerOptions): RelayTlsServer => {
  if (typeof options.Connection !== 'function') {
    throw new Error('Nova TLS server capability is not supported by the active relay host');
  }
  if (!options.authorize({ hostname: options.host, port: options.port, pid: options.pid, tls: true })) {
    throw new Error('relay listen authorization denied');
  }
  const active = new Set<() => void>();
  const disposeListener = relay.registerListener(options.host, options.port, (socket: RelaySocket) => {
    const connection = new options.Connection(options.certificateChain, options.privateKey);
    let disposed = false;
    let secure = false;
    let offData = () => {};
    let offClose = () => {};
    const dispose = (closeSocket: boolean): void => {
      if (disposed) return;
      disposed = true;
      offData(); offClose(); active.delete(close);
      if (closeSocket) socket.close();
    };
    const close = (): void => { connection.close(); dispose(true); };
    active.add(close);
    connection.onciphertext = (data) => { if (!disposed) socket.send(data); };
    connection.onend = () => dispose(true);
    connection.onerror = (error) => {
      options.onTlsClientError?.(error instanceof Error ? error : new Error(String(error)));
      dispose(true);
    };
    connection.onsecure = () => {
      if (disposed || secure) return;
      secure = true;
      const plaintext: RelayTlsPlaintextSocket = {
        onData: (callback) => {
          const previous = connection.onplaintext;
          connection.onplaintext = (data) => {
            previous?.(data);
            callback(data);
          };
          return () => { if (connection.onplaintext !== previous) connection.onplaintext = previous; };
        },
        onClose: (callback) => {
          const previous = connection.onend;
          connection.onend = () => { previous?.(); callback(); };
          return () => { if (connection.onend !== previous) connection.onend = previous; };
        },
        write: (data) => { if (!disposed) connection.writePlaintext(data); },
        close,
      };
      options.onSecureConnection?.(plaintext);
    };
    offData = socket.onData((data) => { if (!disposed) connection.acceptCiphertext(data); });
    offClose = socket.onClose(() => { if (!disposed) connection.close(); dispose(false); });
  });
  return { close: () => { disposeListener(); for (const close of [...active]) close(); } };
};
