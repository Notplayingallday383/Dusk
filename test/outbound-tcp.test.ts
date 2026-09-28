import { expect, test } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createTcpProvider, type TcpStream } from '../src/host/tcp';

class TestStream implements TcpStream {
  readonly writes: Uint8Array[] = [];
  closed = false;
  ended = false;
  private data?: (data: Uint8Array) => void;
  private endHandler?: () => void;
  private error?: (error: unknown) => void;

  write(data: Uint8Array): void { this.writes.push(data); }
  end(): void { this.ended = true; }
  close(): void { this.closed = true; }
  onData(callback: (data: Uint8Array) => void): void { this.data = callback; }
  onEnd(callback: () => void): void { this.endHandler = callback; }
  onError(callback: (error: unknown) => void): void { this.error = callback; }
  emitData(data: number[]): void { this.data?.(Uint8Array.from(data)); }
  emitEnd(): void { this.endHandler?.(); }
  emitError(error: unknown): void { this.error?.(error); }
}

const funcsFor = (manager: ProcessManager, pid: number): Record<string, (message: Record<string, unknown>, send: (response: { value?: unknown; error?: string }) => void) => void> =>
  (manager as unknown as { buildFuncs(pid: number): Record<string, (message: Record<string, unknown>, send: (response: { value?: unknown; error?: string }) => void) => void> }).buildFuncs(pid);

const invoke = (funcs: ReturnType<typeof funcsFor>, name: string, message: Record<string, unknown>): Promise<{ value?: unknown; error?: string }> =>
  new Promise((resolve) => funcs[name]!(message, resolve));

test('outbound TCP provider opens asynchronously and routes stream events only to its guest', async () => {
  const stream = new TestStream();
  const dispatched: Array<{ pid: number; js: string }> = [];
  const provider = createTcpProvider({ open: async (host, port) => {
    expect(host).toBe('ssh.example.test');
    expect(port).toBe(22);
    return stream;
  } });
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { tcpProvider: provider });
  (manager as unknown as { dispatchByPid: Map<number, (js: string) => void> }).dispatchByPid.set(7, (js) => dispatched.push({ pid: 7, js }));
  const guest = funcsFor(manager, 7);

  const connected = await invoke(guest, 'net.connect', { host: 'ssh.example.test', port: 22 });
  const socketId = (connected.value as { socketId: number }).socketId;
  expect(connected.value).toEqual({ socketId });

  await new Promise((resolve) => setTimeout(resolve, 0));
  stream.emitData([1, 2]);
  stream.emitEnd();

  expect(dispatched).toEqual(expect.arrayContaining([
    { pid: 7, js: expect.stringContaining(`'connect', ${socketId}`) },
    { pid: 7, js: expect.stringContaining(`'data', ${socketId}, [1,2]`) },
    { pid: 7, js: expect.stringContaining(`'end', ${socketId}`) },
  ]));
  expect(dispatched.every((event) => event.pid === 7)).toBe(true);
});

test('outbound TCP registry routes writes and closes only for the owning guest', async () => {
  const stream = new TestStream();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, {
    tcpProvider: createTcpProvider({ open: async () => stream }),
  });
  const owner = funcsFor(manager, 7);
  const other = funcsFor(manager, 8);
  const connected = await invoke(owner, 'net.connect', { host: 'ssh.example.test', port: 22 });
  const socketId = (connected.value as { socketId: number }).socketId;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(await invoke(other, 'net.send', { socketId, data: [9] })).toEqual({ error: 'resource belongs to another process' });
  await expect(invoke(owner, 'net.send', { socketId, data: [9] })).resolves.toEqual({ value: true });
  await expect(invoke(owner, 'net.close', { socketId })).resolves.toEqual({ value: true });

  expect(stream.writes).toEqual([Uint8Array.from([9])]);
  expect(stream.closed).toBe(true);
});

test('outbound TCP streams are released when their guest or manager closes', async () => {
  const guestStream = new TestStream();
  const managerStream = new TestStream();
  const streams = [guestStream, managerStream];
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, {
    tcpProvider: createTcpProvider({ open: async () => streams.shift()! }),
  });
  const guest = funcsFor(manager, 7);
  await invoke(guest, 'net.connect', { host: 'ssh.example.test', port: 22 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  (manager as unknown as { cleanupNetworkForPid(pid: number): void }).cleanupNetworkForPid(7);

  expect(guestStream.closed).toBe(true);
  const secondGuest = funcsFor(manager, 8);
  await invoke(secondGuest, 'net.connect', { host: 'ssh.example.test', port: 22 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  manager.close();
  expect(managerStream.closed).toBe(true);
});

test('outbound TCP ignores a guest-supplied pid when authorizing socket operations', async () => {
  const stream = new TestStream();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, {
    tcpProvider: createTcpProvider({ open: async () => stream }),
  });
  const owner = funcsFor(manager, 7);
  const other = funcsFor(manager, 8);
  const connected = await invoke(owner, 'net.connect', { host: 'ssh.example.test', port: 22 });
  const socketId = (connected.value as { socketId: number }).socketId;
  await new Promise((resolve) => setTimeout(resolve, 0));

  await expect(invoke(other, 'net.send', { socketId, data: [9], pid: 7 })).resolves.toEqual({ error: 'resource belongs to another process' });
  await expect(invoke(other, 'net.shutdown', { socketId, pid: 7 })).resolves.toEqual({ error: 'resource belongs to another process' });
  await expect(invoke(other, 'net.close', { socketId, pid: 7 })).resolves.toEqual({ error: 'resource belongs to another process' });

  expect(stream.writes).toEqual([]);
  expect(stream.ended).toBe(false);
  expect(stream.closed).toBe(false);
});

test('outbound TCP queues writes and shutdown until a delayed provider connection opens', async () => {
  let open!: (stream: TestStream) => void;
  const opened = new Promise<TestStream>((resolve) => { open = resolve; });
  const stream = new TestStream();
  const dispatched: string[] = [];
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, {
    tcpProvider: createTcpProvider({ open: async () => opened }),
  });
  (manager as unknown as { dispatchByPid: Map<number, (js: string) => void> }).dispatchByPid.set(7, (js) => dispatched.push(js));
  const guest = funcsFor(manager, 7);
  const connected = await invoke(guest, 'net.connect', { host: 'ssh.example.test', port: 22 });
  const socketId = (connected.value as { socketId: number }).socketId;

  await expect(invoke(guest, 'net.send', { socketId, data: [1] })).resolves.toEqual({ value: true });
  await expect(invoke(guest, 'net.send', { socketId, data: [2] })).resolves.toEqual({ value: true });
  await expect(invoke(guest, 'net.shutdown', { socketId })).resolves.toEqual({ value: true });
  expect(dispatched).toEqual([]);

  open(stream);
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(dispatched[0]).toContain(`'connect', ${socketId}`);
  expect(stream.writes).toEqual([Uint8Array.from([1]), Uint8Array.from([2])]);
  expect(stream.ended).toBe(true);
});

test('outbound TCP dispatches connect before synchronous provider events', async () => {
  const dispatched: string[] = [];
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, {
    tcpProvider: createTcpProvider({ open: async () => ({
      write: () => {},
      end: () => {},
      close: () => {},
      onData: (callback) => callback(Uint8Array.from([1])),
      onEnd: (callback) => callback(),
      onError: () => {},
    }) }),
  });
  (manager as unknown as { dispatchByPid: Map<number, (js: string) => void> }).dispatchByPid.set(7, (js) => dispatched.push(js));
  const guest = funcsFor(manager, 7);
  const connected = await invoke(guest, 'net.connect', { host: 'ssh.example.test', port: 22 });
  const socketId = (connected.value as { socketId: number }).socketId;

  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(dispatched.map((js) => js.match(/dispatch\('([^']+)'/)?.[1])).toEqual(['connect', 'data', 'end']);
  expect(dispatched[0]).toContain(`'connect', ${socketId}`);
});
