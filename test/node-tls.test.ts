import { expect, test } from 'vitest';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { createNet } from '../src/host/net';
import { createRunner } from '../src/host/runner';

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!predicate()) throw new Error('timed out waiting for condition');
};

class FakeTLSSocket {
  static sockets: FakeTLSSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((data: Uint8Array) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((error: unknown) => void) | null = null;
  readonly sent: Uint8Array[] = [];
  closed = 0;

  constructor(readonly host: string, readonly port: number, readonly opts?: unknown) {
    FakeTLSSocket.sockets.push(this);
  }

  send(data: Uint8Array): void { this.sent.push(Uint8Array.from(data)); }
  close(): void { this.closed++; }
  open(): void { this.onopen?.(); }
  message(data: number[]): void { this.onmessage?.(Uint8Array.from(data)); }
  fail(message: string): void { this.onerror?.(new Error(message)); }
}

const makeNetRunner = async (withTls = true) => {
  FakeTLSSocket.sockets = [];
  const output: string[] = [];
  let runner: Awaited<ReturnType<typeof createRunner>>;
  const net = createNet(
    async () => ({
      load_wasm: async () => {},
      set_websocket: () => {},
      fetch: async () => new Response('unused'),
      WebSocket: class {} as unknown as typeof WebSocket,
      ...(withTls ? { TLSSocket: FakeTLSSocket } : {}),
    }),
    (js) => runner.dispatch(js),
    'wss://stub/ws/',
  );
  runner = await createRunner({ ...createFuncs(createMemoryBackend(), (text) => output.push(text)), ...net.funcs });
  return { net, output, runner };
};

test('tls.connect creates a Duplex TLSSocket for positional and options overloads after raw open', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run([
      "const tls = require('node:tls');",
      "const first = tls.connect(8443, 'first.test', () => process.stdout.write('FIRST_CALLBACK:'));",
      "first.on('secureConnect', () => process.stdout.write('FIRST_SECURE:'));",
      "const second = tls.connect({ port: 9443, host: 'second.test' }, () => process.stdout.write('SECOND_CALLBACK:'));",
      "second.on('secureConnect', () => process.stdout.write('SECOND_SECURE:'));",
    ].join(' '));
    await waitFor(() => FakeTLSSocket.sockets.length === 2);

    expect(FakeTLSSocket.sockets.map((socket) => [socket.host, socket.port, socket.opts])).toEqual([
      ['first.test', 8443, undefined],
      ['second.test', 9443, undefined],
    ]);
    expect(output.join('')).not.toContain('SECURE');

    FakeTLSSocket.sockets[0]!.open();
    FakeTLSSocket.sockets[1]!.open();
    await waitFor(() => output.join('').includes('SECOND_SECURE'));
    expect(output.join('')).toContain('FIRST_CALLBACK:FIRST_SECURE:SECOND_CALLBACK:SECOND_SECURE:');
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS buffers writes and their callbacks until raw open, then forwards proxy options', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run([
      "const tls = require('tls');",
      "const socket = tls.connect({ port: 443, host: 'buffered.test', proxy: 'socks5://proxy.test:1080' });",
      "process.stdout.write('INITIAL=' + socket.connecting + ':' + socket.authorized + ':');",
      "socket.write(Uint8Array.from([7, 8]), () => process.stdout.write('WRITE_CALLBACK:'));",
    ].join(' '));
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    const socket = FakeTLSSocket.sockets[0]!;
    expect(socket.opts).toEqual({ proxy: 'socks5://proxy.test:1080' });
    expect(socket.sent).toEqual([]);
    expect(output.join('')).toContain('INITIAL=true:false:');
    expect(output.join('')).not.toContain('WRITE_CALLBACK:');

    socket.open();
    await waitFor(() => output.join('').includes('WRITE_CALLBACK:'));
    expect(socket.sent.map((data) => [...data])).toEqual([[7, 8]]);
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS rejects unimplemented connection controls instead of silently discarding them', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run("const tls = require('tls'); for (const name of ['localAddress', 'localPort', 'family', 'lookup', 'hints', 'timeout', 'noDelay', 'keepAlive', 'keepAliveInitialDelay', 'autoSelectFamily', 'autoSelectFamilyAttemptTimeout', 'signal']) { try { tls.connect({ port: 443, host: 'unsupported.test', [name]: true }); process.stdout.write('ALLOWED=' + name + ':'); } catch (error) { process.stdout.write(name + '=' + error.message + ':'); } }");
    await waitFor(() => output.join('').includes('signal='));
    for (const name of ['localAddress', 'localPort', 'family', 'lookup', 'hints', 'timeout', 'noDelay', 'keepAlive', 'keepAliveInitialDelay', 'autoSelectFamily', 'autoSelectFamilyAttemptTimeout', 'signal']) {
      expect(output.join('')).toContain(`${name}=browser TLS does not support ${name}:`);
    }
    expect(FakeTLSSocket.sockets).toHaveLength(0);
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS terminal paths update state, deliver EOF, and emit close once', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run("const tls = require('tls'); const socket = tls.connect(443, 'lifecycle.test'); socket.on('end', () => process.stdout.write('END:')); socket.on('close', () => process.stdout.write('CLOSE:')); socket.on('error', () => process.stdout.write('ERROR:')); globalThis.socket = socket;");
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    const socket = FakeTLSSocket.sockets[0]!;
    socket.open();
    socket.onclose?.();
    await waitFor(() => output.join('').includes('END:CLOSE:'));
    expect(output.join('').match(/CLOSE:/g)).toHaveLength(1);

    await runner.run("process.stdout.write('STATE=' + globalThis.socket.connecting + ':' + globalThis.socket.authorized + ':' + globalThis.socket.readableEnded + ':'); globalThis.socket.destroy();");
    await waitFor(() => output.join('').includes('STATE='));
    expect(output.join('')).toContain('STATE=false:true:true:');
    expect(output.join('').match(/CLOSE:/g)).toHaveLength(1);
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS destroy(error) emits one error followed by one close', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run("const tls = require('tls'); const socket = tls.connect(443, 'destroy.test'); socket.on('error', () => process.stdout.write('ERROR:')); socket.on('close', () => process.stdout.write('CLOSE:')); globalThis.destroySocket = socket;");
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    FakeTLSSocket.sockets[0]!.open();
    await runner.run("globalThis.destroySocket.destroy(new Error('destroyed')); ");
    await waitFor(() => output.join('').includes('CLOSE:'));
    expect(output.join('')).toBe('ERROR:CLOSE:');
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS normal end emits finish then one close', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run("const tls = require('tls'); const socket = tls.connect(443, 'end.test'); socket.on('finish', () => process.stdout.write('FINISH:')); socket.on('close', () => process.stdout.write('CLOSE:')); globalThis.endSocket = socket;");
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    FakeTLSSocket.sockets[0]!.open();
    await runner.run('globalThis.endSocket.end();');
    await waitFor(() => output.join('').includes('CLOSE:'));
    expect(output.join('')).toBe('FINISH:CLOSE:');
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS remote close ends writable when allowHalfOpen is false', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run("const tls = require('tls'); const socket = tls.connect({ port: 443, host: 'remote-close.test', allowHalfOpen: false }); socket.on('finish', () => process.stdout.write('FINISH:')); socket.on('end', () => process.stdout.write('END:')); socket.on('close', () => process.stdout.write('CLOSE:')); globalThis.remoteSocket = socket;");
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    const socket = FakeTLSSocket.sockets[0]!;
    socket.open();
    socket.onclose?.();
    await waitFor(() => output.join('').includes('CLOSE:'));
    await runner.run("process.stdout.write('WRITABLE=' + globalThis.remoteSocket.writableEnded + ':' + globalThis.remoteSocket.writableFinished + ':');");
    await waitFor(() => output.join('').includes('WRITABLE='));
    expect(output.join('')).toBe('FINISH:END:CLOSE:WRITABLE=true:true:');
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS reports unavailable when the active Nova instance lacks TLSSocket support', async () => {
  const { output, runner } = await makeNetRunner(false);
  try {
    await runner.run("const tls = require('tls'); const socket = tls.connect(443, 'missing.test'); socket.on('error', (error) => process.stdout.write('ERROR=' + error.message + ':STATE=' + socket.connecting + ':' + socket.authorized + ':')); socket.on('close', () => process.stdout.write('CLOSE:'));");
    await waitFor(() => output.join('').includes('CLOSE:'));
    expect(output.join('')).toContain('ERROR=TLSSocket not supported by active instance:STATE=false:false:CLOSE:');
  } finally {
    runner.stop();
  }
}, 60_000);

test('TLS sockets transmit bytes and propagate data, end, error, close, and destroy', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run([
      "const tls = require('tls');",
      "const socket = tls.connect({ port: 443, host: 'bytes.test' }, () => { socket.write(Uint8Array.from([1, 2])); socket.end(Uint8Array.from([3])); });",
      "socket.on('data', (data) => process.stdout.write('DATA=' + Array.from(data).join(',') + ':'));",
      "socket.on('finish', () => process.stdout.write('FINISH:'));",
      "socket.on('close', () => process.stdout.write('CLOSE:'));",
      "socket.on('error', (error) => process.stdout.write('ERROR=' + error.message + ':'));",
    ].join(' '));
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    const socket = FakeTLSSocket.sockets[0]!;
    socket.open();
    await waitFor(() => socket.sent.length === 2);
    expect(socket.sent.map((data) => [...data])).toEqual([[1, 2], [3]]);
    expect(socket.closed).toBe(1);
    await waitFor(() => output.join('').includes('FINISH:CLOSE:'));
    expect(output.join('')).toContain('FINISH:CLOSE:');

    await runner.run("const tls = require('tls'); const inbound = tls.connect(443, 'inbound.test'); inbound.on('data', (data) => process.stdout.write('DATA=' + Array.from(data).join(',') + ':')); inbound.on('end', () => process.stdout.write('END:')); inbound.on('close', () => process.stdout.write('INBOUND_CLOSE:'));");
    await waitFor(() => FakeTLSSocket.sockets.length === 2);
    const inbound = FakeTLSSocket.sockets[1]!;
    inbound.open();
    inbound.message([4, 5]);
    inbound.onclose?.();
    await waitFor(() => output.join('').includes('INBOUND_CLOSE:'));
    expect(output.join('')).toContain('DATA=4,5:END:INBOUND_CLOSE:');

    await runner.run("const tls = require('tls'); const broken = tls.connect(443, 'error.test'); broken.on('error', (error) => process.stdout.write('ERROR=' + error.message + ':')); broken.on('close', () => process.stdout.write('BROKEN_CLOSE:'));");
    await waitFor(() => FakeTLSSocket.sockets.length === 3);
    FakeTLSSocket.sockets[2]!.fail('raw failure');
    await waitFor(() => output.join('').includes('ERROR=Error: raw failure:'));
    expect(output.join('')).toContain('ERROR=Error: raw failure:BROKEN_CLOSE:');

  } finally {
    runner.stop();
  }
}, 60_000);

test('host TLS cleanup closes sockets owned by an exited process', async () => {
  const { net, runner } = await makeNetRunner();
  try {
    await new Promise<void>((resolve) => net.funcs['net.tls.open']!({ host: 'owned.test', port: 443, pid: 73 }, () => resolve()));
    await waitFor(() => FakeTLSSocket.sockets.length === 1);
    net.cleanupForPid(73);
    expect(FakeTLSSocket.sockets[0]!.closed).toBe(1);
  } finally {
    runner.stop();
  }
}, 60_000);

test('tls.connect rejects TLS controls that the Nova bridge cannot configure', async () => {
  const { output, runner } = await makeNetRunner();
  try {
    await runner.run("const tls = require('tls'); for (const name of ['ca', 'cert', 'key', 'servername', 'ALPNProtocols', 'rejectUnauthorized']) { try { tls.connect({ port: 443, host: 'unsupported.test', [name]: name }); process.stdout.write('ALLOWED=' + name + ':'); } catch (error) { process.stdout.write(name + '=' + error.message + ':'); } }");
    await waitFor(() => output.join('').includes('rejectUnauthorized='));
    for (const name of ['ca', 'cert', 'key', 'servername', 'ALPNProtocols', 'rejectUnauthorized']) {
      expect(output.join('')).toContain(`${name}=browser TLS does not support ${name}:`);
    }
    expect(FakeTLSSocket.sockets).toHaveLength(0);
  } finally {
    runner.stop();
  }
}, 60_000);
