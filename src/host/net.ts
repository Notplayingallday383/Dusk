import type { FuncTable, SendFn } from './runner';

export interface NetHost {
  funcs: FuncTable;
  registerLibcurl(name: string, instance: LibCurl): void;
  registerTransport(name: string, transport: unknown): void;
}

export interface LibCurl {
  load_wasm(url?: string): Promise<void>;
  set_websocket(url: string): void;
  fetch(url: string, opts?: unknown): Promise<Response>;
  WebSocket: new (url: string, protocols?: string[]) => WebSocket;
  transport?: unknown;
  version?: unknown;
  HTTPSession?: new (opts?: unknown) => { fetch(url: string, opts?: unknown): Promise<Response>; close(): void };
  TLSSocket?: new (host: string, port: number, opts?: unknown) => {
    onopen: (() => void) | null;
    onmessage: ((d: Uint8Array) => void) | null;
    onclose: (() => void) | null;
    onerror: ((e: unknown) => void) | null;
    send(data: Uint8Array): void;
    close(): void;
  };
}

export const createNet = (
  loadLibcurl: () => Promise<LibCurl>,
  dispatch: (js: string) => void,
  proxyUrl: string,
): NetHost => {
  const instances = new Map<string, LibCurl>();
  const transports = new Map<string, unknown>();
  let activeName = 'default';
  let loadedDefault: LibCurl | undefined;

  const ensureActive = async (): Promise<LibCurl> => {
    if (activeName === 'default' && !instances.has('default')) {
      if (!loadedDefault) {
        loadedDefault = await loadLibcurl();
        await loadedDefault.load_wasm();
        loadedDefault.set_websocket(proxyUrl);
        instances.set('default', loadedDefault);
      }
    }
    const inst = instances.get(activeName);
    if (!inst) throw new Error('libcurl instance not registered: ' + activeName);
    return inst;
  };

  let nextId = 1;
  const sockets = new Map<number, WebSocket>();
  const tlsSockets = new Map<number, InstanceType<NonNullable<LibCurl['TLSSocket']>>>();
  const sessions = new Map<number, InstanceType<NonNullable<LibCurl['HTTPSession']>>>();

  const enc = (v: unknown): string => JSON.stringify(v);
  const fire = (id: number, kind: string, payload: unknown): void =>
    dispatch(`globalThis.__net.dispatch(${id}, ${JSON.stringify(kind)}, ${enc(payload)})`);

  const funcs: FuncTable = {
    'net.fetch': (m, send: SendFn) => {
      const id = nextId++;
      send({ value: id });
      void (async () => {
        try {
          const c = await ensureActive();
          const res = await c.fetch(m['url'] as string, m['opts']);
          const body = await res.text();
          fire(id, 'response', { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body });
        } catch (e) { fire(id, 'error', String(e)); }
      })();
    },
    'net.fetch.sync': (m, send: SendFn) => {
      void (async () => {
        try {
          const c = await ensureActive();
          const res = await c.fetch(m['url'] as string, m['opts']);
          const body = await res.text();
          send({ value: { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body } });
        } catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.ws.open': (m, send: SendFn) => {
      const id = nextId++;
      send({ value: id });
      void (async () => {
        try {
          const c = await ensureActive();
          const ws = new c.WebSocket(m['url'] as string, (m['protocols'] as string[]) ?? []);
          sockets.set(id, ws);
          ws.addEventListener('open', () => fire(id, 'open', null));
          ws.addEventListener('message', (e: MessageEvent) => fire(id, 'message', e.data));
          ws.addEventListener('close', () => fire(id, 'close', null));
          ws.addEventListener('error', () => fire(id, 'error', 'ws error'));
        } catch (e) { fire(id, 'error', String(e)); }
      })();
    },
    'net.ws.send': (m, send: SendFn) => {
      const ws = sockets.get(m['id'] as number);
      if (ws) ws.send(m['data'] as string);
      send({});
    },
    'net.ws.close': (m, send: SendFn) => {
      const ws = sockets.get(m['id'] as number);
      if (ws) ws.close();
      sockets.delete(m['id'] as number);
      send({});
    },
    'net.cfg.set_instance': (m, send: SendFn) => {
      const name = m['name'] as string;
      if (typeof name !== 'string') { send({ error: 'instance name must be a string' }); return; }
      if (name !== 'default' && !instances.has(name)) { send({ error: 'libcurl instance not registered: ' + name }); return; }
      activeName = name;
      send({ value: true });
    },
    'net.cfg.set_websocket': (m, send: SendFn) => {
      void (async () => {
        try { (await ensureActive()).set_websocket(m['url'] as string); send({ value: true }); }
        catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.cfg.get_transport': (_m, send: SendFn) => {
      void (async () => {
        try { send({ value: (await ensureActive()).transport ?? null }); }
        catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.cfg.set_transport': (m, send: SendFn) => {
      void (async () => {
        try {
          const name = m['transport'] as string;
          const c = await ensureActive();
          if (name === 'wisp' || name === 'wsproxy') { c.transport = name; send({ value: true }); return; }
          if (transports.has(name)) { c.transport = transports.get(name); send({ value: true }); return; }
          send({ error: 'transport not registered: ' + name });
        } catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.cfg.version': (_m, send: SendFn) => {
      void (async () => {
        try { send({ value: (await ensureActive()).version ?? null }); }
        catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.session.create': (m, send: SendFn) => {
      void (async () => {
        try {
          const c = await ensureActive();
          if (!c.HTTPSession) { send({ error: 'HTTPSession not supported by active instance' }); return; }
          const id = nextId++;
          sessions.set(id, new c.HTTPSession(m['opts']));
          send({ value: id });
        } catch (e) { send({ error: String(e) }); }
      })();
    },
    'net.session.fetch': (m, send: SendFn) => {
      const id = nextId++;
      send({ value: id });
      void (async () => {
        try {
          const s = sessions.get(m['sid'] as number);
          if (!s) { fire(id, 'error', 'unknown session: ' + m['sid']); return; }
          const res = await s.fetch(m['url'] as string, m['opts']);
          const body = await res.text();
          fire(id, 'response', { status: res.status, statusText: res.statusText, headers: [...res.headers.entries()], body });
        } catch (e) { fire(id, 'error', String(e)); }
      })();
    },
    'net.session.close': (m, send: SendFn) => {
      const s = sessions.get(m['sid'] as number);
      if (s) s.close();
      sessions.delete(m['sid'] as number);
      send({ value: true });
    },
    'net.tls.open': (m, send: SendFn) => {
      const id = nextId++;
      send({ value: id });
      void (async () => {
        try {
          const c = await ensureActive();
          if (!c.TLSSocket) { fire(id, 'error', 'TLSSocket not supported by active instance'); return; }
          const sock = new c.TLSSocket(m['host'] as string, m['port'] as number, m['opts']);
          tlsSockets.set(id, sock);
          sock.onopen = () => fire(id, 'open', null);
          sock.onmessage = (d: Uint8Array) => fire(id, 'message', [...d]);
          sock.onclose = () => fire(id, 'close', null);
          sock.onerror = (e: unknown) => fire(id, 'error', String(e));
        } catch (e) { fire(id, 'error', String(e)); }
      })();
    },
    'net.tls.send': (m, send: SendFn) => {
      const sock = tlsSockets.get(m['id'] as number);
      if (sock) sock.send(Uint8Array.from(m['data'] as number[]));
      send({});
    },
    'net.tls.close': (m, send: SendFn) => {
      const sock = tlsSockets.get(m['id'] as number);
      if (sock) sock.close();
      tlsSockets.delete(m['id'] as number);
      send({});
    },
  };

  return {
    funcs,
    registerLibcurl: (name, instance) => { instances.set(name, instance); },
    registerTransport: (name, transport) => { transports.set(name, transport); },
  };
};
