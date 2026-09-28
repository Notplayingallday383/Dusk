import { registerFetchDispatch } from './net-router';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

export const installNet = (): void => {
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  const wsHandlers = new Map<number, Record<string, ((d: unknown) => void)[]>>();
  const responseFrom = (raw: unknown): {
    status: number;
    statusText: string;
    headers: Map<string, string>;
    ok: boolean;
    text: () => Promise<string>;
    json: () => Promise<unknown>;
    arrayBuffer: () => Promise<ArrayBuffer>;
  } => {
    const r = raw as { status: number; statusText: string; headers: [string, string][]; body: number[] };
    const bytes = Uint8Array.from(r.body);
    const text = (): string => new TextDecoder().decode(bytes);
    return {
      status: r.status,
      statusText: r.statusText,
      headers: new Map(r.headers),
      ok: r.status >= 200 && r.status < 300,
      text: () => Promise.resolve(text()),
      json: () => Promise.resolve(JSON.parse(text())),
      arrayBuffer: () => Promise.resolve(bytes.slice().buffer),
    };
  };

  registerFetchDispatch((id: number, kind: string, payload: unknown): void => {
    const p = pending.get(id);
    if (p) {
      if (kind === 'response') { p.resolve(payload); pending.delete(id); }
      else if (kind === 'error') { p.reject(new Error(String(payload))); pending.delete(id); }
      return;
    }
    const handlers = wsHandlers.get(id);
    if (handlers) for (const cb of handlers[kind] ?? []) cb(payload);
  });

  (globalThis as Record<string, unknown>)['fetch'] = (url: string, opts?: unknown): Promise<unknown> => {
    const id = call('net.fetch', { url, opts }) as number;
    return new Promise((resolve, reject) => {
      pending.set(id, {
        resolve: (raw) => { resolve(responseFrom(raw)); },
        reject,
      });
    });
  };

  (globalThis as Record<string, unknown>)['WebSocket'] = class {
    private id: number;
    onopen: (() => void) | null = null;
    onmessage: ((e: { data: unknown }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(url: string, protocols: string[] = []) {
      this.id = call('net.ws.open', { url, protocols }) as number;
      wsHandlers.set(this.id, {
        open: [() => this.onopen?.()],
        message: [(d) => this.onmessage?.({ data: Array.isArray(d) ? Uint8Array.from(d) : d })],
        close: [() => this.onclose?.()],
        error: [(e) => this.onerror?.(e)],
      });
    }
    send(data: string): void { call('net.ws.send', { id: this.id, data }); }
    close(): void { call('net.ws.close', { id: this.id }); wsHandlers.delete(this.id); }
  };

  (globalThis as Record<string, unknown>)['XMLHttpRequest'] = class {
    private method = 'GET';
    private url = '';
    private async_ = true;
    status = 0;
    statusText = '';
    responseText = '';
    onload: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    readyState = 0;
    onreadystatechange: (() => void) | null = null;

    open(method: string, url: string, async = true): void {
      this.method = method; this.url = url; this.async_ = async; this.readyState = 1;
    }

    private apply(r: { status: number; statusText: string; body: number[] }): void {
      this.status = r.status;
      this.statusText = r.statusText;
      this.responseText = new TextDecoder().decode(Uint8Array.from(r.body));
      this.readyState = 4; this.onreadystatechange?.(); this.onload?.();
    }

    send(body?: string): void {
      const opts = { method: this.method, body };
      if (!this.async_) {
        const r = call('net.fetch.sync', { url: this.url, opts }) as { status: number; statusText: string; body: number[] };
        this.apply(r);
        return;
      }
      const id = call('net.fetch', { url: this.url, opts }) as number;
      pending.set(id, {
        resolve: (raw) => this.apply(raw as { status: number; statusText: string; body: number[] }),
        reject: (e) => this.onerror?.(e),
      });
    }
  };

  const g = globalThis as Record<string, unknown>;
  if (!g['dusk']) g['dusk'] = {};
  const dusk = g['dusk'] as Record<string, unknown>;

  const libcurlProxy = {
    set_websocket: (url: string): void => { call('net.cfg.set_websocket', { url }); },
    get transport(): unknown { return call('net.cfg.get_transport', {}); },
    set transport(name: unknown) { call('net.cfg.set_transport', { transport: name }); },
    get version(): unknown { return call('net.cfg.version', {}); },
  };

  (libcurlProxy as Record<string, unknown>)['HTTPSession'] = class {
    private sid: number;
    constructor(opts?: unknown) { this.sid = call('net.session.create', { opts }) as number; }
    fetch(url: string, opts?: unknown): Promise<unknown> {
      const id = call('net.session.fetch', { sid: this.sid, url, opts }) as number;
      return new Promise((resolve, reject) => {
        pending.set(id, {
          resolve: (raw) => {
            resolve(responseFrom(raw));
          },
          reject,
        });
      });
    }
    close(): void { call('net.session.close', { sid: this.sid }); }
  };

  (libcurlProxy as Record<string, unknown>)['TLSSocket'] = class {
    private id: number;
    onopen: (() => void) | null = null;
    onmessage: ((d: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(host: string, port: number, opts?: unknown) {
      this.id = call('net.tls.open', { host, port, opts }) as number;
      wsHandlers.set(this.id, {
        open: [() => this.onopen?.()],
        message: [(d) => this.onmessage?.(Uint8Array.from(d as number[]))],
        close: [() => this.onclose?.()],
        error: [(e) => this.onerror?.(e)],
      });
    }
    send(data: Uint8Array): void { call('net.tls.send', { id: this.id, data: [...data] }); }
    close(): void { call('net.tls.close', { id: this.id }); wsHandlers.delete(this.id); }
  };

  Object.defineProperty(dusk, 'libcurl', {
    configurable: true,
    enumerable: true,
    get(): unknown { return libcurlProxy; },
    set(value: unknown) {
      if (typeof value !== 'string') throw new Error('dusk.libcurl can only be reassigned to a registered instance name (string)');
      call('net.cfg.set_instance', { name: value });
    },
  });
};
