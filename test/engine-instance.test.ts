import { afterEach, test, expect, vi } from 'vitest';

vi.mock('../src/engine/spidermonkey', () => ({
  resolveSpiderMonkey: async () => ({
    wasmUrl: 'https://example.invalid/js.wasm',
    args: ['js.wasm', '-f', '/input.js'],
    wasmModule: {} as WebAssembly.Module,
  }),
}));

import { createEngine, createSpiderMonkeyLegacyEngine } from '../src/host/engine-instance';

class LegacyMockWorker {
  static instance: LegacyMockWorker | undefined;
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly messages: unknown[] = [];

  constructor(..._args: unknown[]) { LegacyMockWorker.instance = this; }
  postMessage(message: unknown): void { this.messages.push(message); }
  terminate(): Promise<number> { return Promise.resolve(1); }
  receive(message: unknown): void { this.onmessage?.({ data: message } as MessageEvent); }
}

afterEach(() => {
  LegacyMockWorker.instance = undefined;
  vi.unstubAllGlobals();
});

test('SpiderMonkey legacy engine runs through its SAB wait scheduler', async () => {
  vi.stubGlobal('Worker', LegacyMockWorker);
  const engine = await createSpiderMonkeyLegacyEngine(9);
  const worker = LegacyMockWorker.instance!;
  const init = worker.messages[0] as { lengthBuffer: SharedArrayBuffer; valueBuffer: SharedArrayBuffer };

  const run = engine.run('globalThis.legacyExecuted = true;');
  worker.receive({ type: 'wait' });
  const length = Atomics.load(new Int32Array(init.lengthBuffer), 0);
  const body = new TextDecoder().decode(new Uint8Array(init.valueBuffer, 0, length).slice());
  expect(body).toBe('JS|globalThis.legacyExecuted = true;');
  worker.receive({ type: 'done' });
  await expect(run).resolves.toBeUndefined();
  await engine.terminate();
});

test('SpiderMonkey legacy dispatch resolves after its evaluated callback completes', async () => {
  vi.stubGlobal('Worker', LegacyMockWorker);
  const engine = await createSpiderMonkeyLegacyEngine(9);
  const worker = LegacyMockWorker.instance!;

  const dispatched = engine.dispatch('globalThis.legacyDispatch = true;');
  worker.receive({ type: 'wait' });
  worker.receive({ type: 'done' });

  await expect(Promise.race([
    dispatched.then(() => 'resolved'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 100)),
  ])).resolves.toBe('resolved');
  await engine.terminate();
});

test('createEngine boots SpiderMonkey and runs user JS', async () => {
  const seen: unknown[] = [];
  const engine = await createEngine(0, {
    'console.log': (msg, send) => { seen.push((msg as { args: unknown[] }).args[0]); send({}); },
  });
  await engine.run('print(JSON.stringify({ f: "console.log", args: [1 + 1] }))');
  await engine.terminate();
  expect(seen).toContain(2);
}, 60_000);

test('createEngine terminates with exit code', async () => {
  const engine = await createEngine(1, {});
  await engine.terminate();
  const code = await engine.exited;
  expect(code).toBe(1);
}, 60_000);

test('process.exit terminates the engine with exit code', async () => {
  const engine = await createEngine(1, {
    'process.exit': (_m, send) => { send({}); },
    'proc.write': (_m, send) => { send({}); },
  });
  void engine.run('process.exit(0)');
  const code = await engine.exited;
  expect(code).toBe(0);
}, 60_000);

test('process.pid is set', async () => {
  let pid: unknown;
  const engine = await createEngine(42, {
    'console.log': (msg, send) => { pid = (msg as { args: unknown[] }).args[0]; send({}); },
    'proc.write': (_m, send) => { send({}); },
  });
  await engine.run('print(JSON.stringify({ f: "console.log", args: [process.pid] }))');
  await engine.terminate();
  expect(pid).toBe(42);
}, 60_000);

test('createEngine stamps host PID independently of a guest-supplied pid', async () => {
  let pid: unknown;
  const engine = await createEngine(42, {
    capture: (msg, send) => { pid = msg['__enginePid']; send({}); },
  });
  await engine.run('print(JSON.stringify({ f: "capture", pid: 999 }))');
  await engine.terminate();
  expect(pid).toBe(42);
}, 60_000);
