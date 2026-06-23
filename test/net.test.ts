import { test, expect } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { createNet } from '../src/host/net';

// NOTE: The default test uses a STUBBED libcurl because this headless CI env has
// no Wisp proxy at wss://<host>/ws/. The stub exercises the full async
// event-pump bridge: in-engine fetch() -> net.fetch func -> stub fetch ->
// fire('response') -> runner.dispatch -> __net.dispatch -> promise resolves ->
// console.log on the host. The live-proxy variant is documented as test.skip.

const makeStubLibcurl = () => ({
  load_wasm: async () => {},
  set_websocket: (_url: string) => {},
  fetch: async (_url: string, _opts?: unknown) =>
    ({
      status: 200,
      statusText: 'OK',
      headers: new Map<string, string>([['content-type', 'text/plain']]),
      text: async () => 'hello world',
    }) as unknown as Response,
  WebSocket: class {
    constructor(_url: string, _protocols?: string[]) {}
    addEventListener() {}
    send() {}
    close() {}
  } as unknown as new (url: string, protocols?: string[]) => WebSocket,
  HTTPSession: class {
    constructor(_opts?: unknown) {}
    fetch = async (_url: string, _opts?: unknown) => ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => 'SESSION-BODY' }) as unknown as Response;
    close() {}
  } as unknown as new (opts?: unknown) => { fetch(url: string, opts?: unknown): Promise<Response>; close(): void },
  TLSSocket: class {
    onopen: (() => void) | null = null;
    onmessage: ((d: Uint8Array) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    constructor(_host: string, _port: number, _opts?: unknown) {
      setTimeout(() => { this.onopen?.(); this.onmessage?.(Uint8Array.from([72, 73])); }, 0);
    }
    send(_data: Uint8Array) {}
    close() {}
  } as unknown as new (host: string, port: number, opts?: unknown) => unknown,
});

test('fetch round-trips through the async event-pump (stubbed libcurl)', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => makeStubLibcurl() as never,
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://example.com").then(r => r.text()).then(t => console.log(t.length > 0))');

  // The response dispatch arrives on a SUBSEQUENT wait/eval cycle (after run()
  // has already resolved). Poll `out` until the round-trip completes.
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('true') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }

  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);

test('synchronous XHR returns a body through libcurl.js', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => makeStubLibcurl() as never,
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const x = new XMLHttpRequest(); x.open("GET", "https://example.com", false); x.send(); console.log(x.responseText.length > 0)');
  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);

test('host registry: registerLibcurl + swap routes fetch through the named instance', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const second = makeStubLibcurl();
  second.fetch = async () => ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => 'SECOND' }) as unknown as Response;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  net.registerLibcurl('alt', second as never);
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('dusk.libcurl = "alt"; fetch("https://x").then(r => r.text()).then(t => console.log(t))');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('SECOND') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('SECOND');
}, 60_000);

test('dusk.libcurl.set_websocket + transport forward to the host', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const stub = makeStubLibcurl() as unknown as { set_websocket: (u: string) => void; transport: unknown; wsCalls: string[] };
  stub.wsCalls = [];
  stub.set_websocket = (u: string) => { stub.wsCalls.push(u); };
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('dusk.libcurl.set_websocket("ws://p/"); dusk.libcurl.transport = "wsproxy"; console.log(String(dusk.libcurl.transport))');
  runner.stop();
  expect(stub.wsCalls).toContain('ws://p/');
  expect(out.join('')).toContain('wsproxy');
}, 60_000);

test('dusk.libcurl reassignment to a non-string throws in the sandbox', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('try { dusk.libcurl = 123; console.log("no-throw"); } catch (e) { console.log("threw"); }');
  runner.stop();
  expect(out.join('')).toContain('threw');
}, 60_000);

test('dusk.libcurl swap to unregistered name throws', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('try { dusk.libcurl = "nope"; console.log("no-throw"); } catch (e) { console.log("threw"); }');
  runner.stop();
  expect(out.join('')).toContain('threw');
}, 60_000);

test('dusk.libcurl.HTTPSession fetch round-trips', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const s = new dusk.libcurl.HTTPSession(); s.fetch("https://x").then(r => r.text()).then(t => { console.log(t); s.close(); })');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('SESSION-BODY') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('SESSION-BODY');
}, 60_000);

test('dusk.libcurl.TLSSocket receives a message', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(async () => makeStubLibcurl() as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('const s = new dusk.libcurl.TLSSocket("h", 443); s.onmessage = (d) => console.log("bytes:" + d.length); s.onopen = () => console.log("open")');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('bytes:2') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('bytes:2');
}, 60_000);

test('per-request proxy opt reaches the active instance fetch', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const stub = makeStubLibcurl() as unknown as { fetch: (u: string, o?: unknown) => Promise<Response>; seenOpts: unknown[] };
  stub.seenOpts = [];
  stub.fetch = async (_u: string, o?: unknown) => {
    stub.seenOpts.push(o);
    return ({ status: 200, statusText: 'OK', headers: new Map(), text: async () => 'ok' }) as unknown as Response;
  };
  const net = createNet(async () => stub as never, (js) => runner.dispatch(js), 'wss://stub/ws/');
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://x", { proxy: "socks5h://127.0.0.1:1080" }).then(r => r.text()).then(t => console.log(t))');
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('ok') === -1 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  runner.stop();
  expect(out.join('')).toContain('ok');
  expect(JSON.stringify(stub.seenOpts)).toContain('socks5h://127.0.0.1:1080');
}, 60_000);

test.skip('fetch returns a body through libcurl.js (live Wisp proxy)', async () => {
  const vfs = createMemoryBackend();
  const out: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => (await import('libcurl.js')).libcurl as never,
    (js) => runner.dispatch(js),
    `wss://${location.hostname}/ws/`,
  );
  runner = await createRunner({ ...createFuncs(vfs, (t) => out.push(t)), ...net.funcs });
  await runner.run('fetch("https://example.com").then(r => r.text()).then(t => console.log(t.length > 0))');
  runner.stop();
  expect(out.join('')).toContain('true');
}, 60_000);
