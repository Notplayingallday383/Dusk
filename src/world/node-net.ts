import { Duplex } from './node-stream';
import { EventEmitter } from './node-events';
import { codes, errnoError } from './node-errors';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    const m = /^([A-Z_]+):/.exec(r.error);
    const code = m && m[1] ? m[1] : 'UNKNOWN';
    const syscall = f.replace(/^net\./, '');
    throw errnoError(code, syscall, undefined, r.error);
  }
  return r.value;
};

const socketsById = new Map<number, Socket>();
const serversById = new Map<number, Server>();

// Engine-global hook used by the host dispatch to deliver net events.
(globalThis as Record<string, unknown>)['__net'] = {
  dispatch(event: 'connection' | 'data' | 'end' | 'error' | 'connect',
           socketId: number, payload?: unknown): void {
    if (event === 'connection') {
      const serverId = socketId;
      const srv = serversById.get(serverId);
      if (!srv) return;
      const clientSocketId = (payload as { clientSocketId: number }).clientSocketId;
      const sock = new Socket({ _existingId: clientSocketId, _existingRemote: 'incoming' });
      socketsById.set(clientSocketId, sock);
      sock._markConnected('incoming', 0);
      srv.emit('connection', sock);
      return;
    }
    const sock = socketsById.get(socketId);
    if (!sock) return;
    if (event === 'data') {
      const bytes = payload as number[];
      sock.push(Uint8Array.from(bytes));
    } else if (event === 'end') {
      sock.push(null);
    } else if (event === 'error') {
      const err = new Error(payload as string);
      sock.destroy(err);
    } else if (event === 'connect') {
      const info = payload as { remoteAddress: string; remotePort: number };
      sock._markConnected(info.remoteAddress, info.remotePort);
    }
  },
};

export interface SocketOpts {
  _existingId?: number;
  _existingRemote?: string;
  allowHalfOpen?: boolean;
}

export interface Socket {
  write(chunk: unknown, encoding?: string | ((err?: Error | null) => void), cb?: (err?: Error | null) => void): boolean;
  end(chunk?: unknown, encoding?: string | (() => void), cb?: () => void): this;
}

export class Socket extends Duplex {
  private _socketId: number;
  remoteAddress = '';
  remotePort = 0;
  remoteFamily = 'IPv4';
  localAddress = '';
  localPort = 0;
  bytesRead = 0;
  bytesWritten = 0;
  connecting = false;
  pending = true;
  readyState: 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed' = 'opening';

  constructor(opts: SocketOpts = {}) {
    super({
      allowHalfOpen: opts.allowHalfOpen ?? false,
      write: (chunk, _enc, cb) => {
        if (this.readyState === 'closed') { cb(codes.ERR_SOCKET_CLOSED!()); return; }
        let bytes: number[];
        if (chunk instanceof Uint8Array) bytes = Array.from(chunk);
        else if (typeof chunk === 'string') {
          bytes = [];
          for (let i = 0; i < (chunk as string).length; i++) bytes.push((chunk as string).charCodeAt(i));
        } else if (Array.isArray(chunk)) bytes = chunk as number[];
        else { cb(codes.ERR_INVALID_ARG_TYPE!('chunk', ['string', 'Uint8Array'], chunk)); return; }
        try {
          __call('net.send', { socketId: this._socketId, data: bytes });
          this.bytesWritten += bytes.length;
          cb();
        } catch (e) { cb(e as Error); }
      },
      final: (cb) => {
        try { __call('net.shutdown', { socketId: this._socketId }); cb(); }
        catch (e) { cb(e as Error); }
      },
    });
    this._socketId = opts._existingId ?? -1;
    if (opts._existingId !== undefined) {
      socketsById.set(this._socketId, this);
    }
  }

  connect(options: { host?: string; port: number; path?: string } | number, ...rest: unknown[]): this {
    let host = '127.0.0.1', port = 0, cb: (() => void) | undefined;
    if (typeof options === 'number') {
      port = options;
      if (typeof rest[0] === 'string') host = rest[0];
      if (typeof rest[rest.length - 1] === 'function') cb = rest[rest.length - 1] as () => void;
    } else if (options && typeof options === 'object') {
      port = (options as { port: number }).port;
      host = (options as { host?: string }).host ?? '127.0.0.1';
      if (typeof rest[0] === 'function') cb = rest[0] as () => void;
    }
    this.connecting = true;
    this.readyState = 'opening';
    try {
      const v = __call('net.connect', { host, port }) as { socketId: number; remoteAddress?: string; remotePort?: number };
      this._socketId = v.socketId;
      socketsById.set(this._socketId, this);
      if (v.remoteAddress) this._markConnected(v.remoteAddress, v.remotePort ?? port);
    } catch (e) {
      Promise.resolve().then(() => this.emit('error', e));
      return this;
    }
    if (cb) this.once('connect', cb);
    return this;
  }

  _markConnected(remoteAddress: string, remotePort: number): void {
    this.connecting = false;
    this.pending = false;
    this.readyState = 'open';
    this.remoteAddress = remoteAddress;
    this.remotePort = remotePort;
    Promise.resolve().then(() => this.emit('connect'));
    Promise.resolve().then(() => this.emit('ready'));
  }

  override setEncoding(_enc: string | null): this {
    return this;
  }

  setKeepAlive(_enable?: boolean, _delay?: number): this { return this; }
  setNoDelay(_v?: boolean): this { return this; }
  setTimeout(timeout: number, cb?: () => void): this {
    if (timeout > 0) {
      const g = globalThis as { setTimeout?: (f: () => void, t: number) => unknown };
      g.setTimeout?.(() => { this.emit('timeout'); if (cb) cb(); }, timeout);
    }
    return this;
  }
  ref(): this { return this; }
  unref(): this { return this; }

  address(): { address: string; port: number; family: string } {
    return { address: this.localAddress || '127.0.0.1', port: this.localPort, family: 'IPv4' };
  }

  override destroy(err?: Error | null): this {
    if (this.readyState !== 'closed') {
      this.readyState = 'closed';
      try { __call('net.close', { socketId: this._socketId }); } catch { /* */ }
      socketsById.delete(this._socketId);
    }
    return super.destroy(err);
  }
}

export class Server extends EventEmitter {
  private _serverId = -1;
  listening = false;
  private _onConnection?: (sock: Socket) => void;

  constructor(opts?: { allowHalfOpen?: boolean } | ((sock: Socket) => void), onConn?: (sock: Socket) => void) {
    super();
    if (typeof opts === 'function') this._onConnection = opts;
    else if (onConn) this._onConnection = onConn;
    if (this._onConnection) this.on('connection', this._onConnection as unknown as (...args: unknown[]) => void);
  }

  listen(...args: unknown[]): this {
    let port = 0, host = '0.0.0.0';
    let cb: (() => void) | undefined;
    for (const a of args) {
      if (typeof a === 'number') port = a;
      else if (typeof a === 'string') host = a;
      else if (typeof a === 'function') cb = a as () => void;
      else if (a && typeof a === 'object') {
        if ('port' in (a as { port?: number })) port = (a as { port: number }).port;
        if ('host' in (a as { host?: string })) host = (a as { host?: string }).host ?? host;
      }
    }
    try {
      const v = __call('net.listen', { host, port }) as { serverId: number };
      this._serverId = v.serverId;
      serversById.set(this._serverId, this);
      this.listening = true;
      Promise.resolve().then(() => {
        this.emit('listening');
        if (cb) cb();
      });
    } catch (e) {
      Promise.resolve().then(() => this.emit('error', e));
    }
    return this;
  }

  close(cb?: (err?: Error) => void): this {
    if (this.listening) {
      try { __call('net.unlisten', { serverId: this._serverId }); } catch { /* */ }
      serversById.delete(this._serverId);
      this.listening = false;
      Promise.resolve().then(() => {
        this.emit('close');
        if (cb) cb();
      });
    } else if (cb) {
      cb(codes.ERR_SERVER_NOT_RUNNING!());
    }
    return this;
  }

  address(): { port: number; address: string; family: string } | null {
    if (!this.listening) return null;
    return { port: 0, address: '0.0.0.0', family: 'IPv4' };
  }

  ref(): this { return this; }
  unref(): this { return this; }
}

export const createServer = (opts?: { allowHalfOpen?: boolean } | ((sock: Socket) => void), onConn?: (sock: Socket) => void): Server => {
  return new Server(opts, onConn);
};

export const createConnection = (
  options: { host?: string; port: number } | number,
  ...rest: unknown[]
): Socket => {
  const sock = new Socket();
  sock.connect(options as { port: number }, ...rest);
  return sock;
};

export const connect = createConnection;

export const isIP = (s: string): number => {
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) {
    const parts = s.split('.').map(Number);
    if (parts.every((p) => p >= 0 && p <= 255)) return 4;
  }
  if (/^[0-9a-f:]+$/i.test(s) && s.includes(':')) return 6;
  return 0;
};

export const isIPv4 = (s: string): boolean => isIP(s) === 4;
export const isIPv6 = (s: string): boolean => isIP(s) === 6;

export const nodeNet = {
  Socket,
  Server,
  createServer,
  createConnection,
  connect,
  isIP,
  isIPv4,
  isIPv6,
};
