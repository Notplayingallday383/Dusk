import { SERIAL_RES_SIZE, type WorldToHost } from '../protocol/messages';
import { resolveSpiderMonkey } from '../engine/spidermonkey';

export type SendFn = (msg: unknown) => void;
export type FuncFn = (msg: Record<string, unknown>, send: SendFn) => void;
export type FuncTable = Record<string, FuncFn>;

export interface EngineInstance {
  pid: number;
  run(js: string): Promise<void>;
  dispatch(js: string): void;
  terminate(): Promise<number>;
  readonly exited: Promise<number>;
}

export const createEngine = async (pid: number, funcs: FuncTable = {}): Promise<EngineInstance> => {
  if (!crossOriginIsolated) throw new Error('DuskJS requires cross-origin isolation (SharedArrayBuffer)');

  const { wasmUrl, args, wasmModule } = await resolveSpiderMonkey();
  const worldJS = (await import('../world/world.ts?worldsrc')).default;

  const worker = new Worker(new URL('../worker/wasi-loader.ts', import.meta.url), { type: 'module' });

  const lengthBuffer = new SharedArrayBuffer(4);
  const lengthTyped = new Int32Array(lengthBuffer);
  const valueBuffer = new SharedArrayBuffer(SERIAL_RES_SIZE);
  const valueTyped = new Uint8Array(valueBuffer);
  const encoder = new TextEncoder();
  void wasmUrl;

  const queue: string[] = [];
  const dispatchQueue: string[] = [];
  let queueResolve: (() => void) | null = null;
  const handlers: Record<string, (msg: WorldToHost & { exitCode?: number }) => void> = {};

  let exitCode = 0;
  let exitResolve: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => { exitResolve = resolve; });

  const pidWorldJS = `const __DUSK_PID__ = ${pid};\n` + worldJS;

  const send: SendFn = (msg) => {
    const bytes = encoder.encode(JSON.stringify(msg));
    if (bytes.length > SERIAL_RES_SIZE) {
      throw new Error('IPC response exceeds SERIAL_RES_SIZE limit (' + bytes.length + ' > ' + SERIAL_RES_SIZE + ')');
    }
    for (let i = 0; i < bytes.length; i++) Atomics.store(valueTyped, i, bytes[i]!);
    Atomics.store(lengthTyped, 0, bytes.length);
    Atomics.notify(lengthTyped, 0);
  };

  handlers.wait = async () => {
    while (queue.length === 0 && dispatchQueue.length === 0) {
      await new Promise<void>((res) => { queueResolve = res; });
    }
    queueResolve = null;
    // Primary run() bodies ALWAYS go first — dispatch envelopes cannot preempt
    // the entry script during engine boot. Otherwise a signal delivered before
    // the body has had a chance to register handlers will run before it and
    // hit the default-terminate branch (see src/world/node-process.ts:426).
    if (queue.length > 0) send({ type: 'eval', js: queue.pop() });
    else send({ type: 'eval', js: dispatchQueue.shift() });
  };

  handlers.exit = (msg) => {
    exitCode = msg.exitCode ?? 0;
    worker.terminate();
    exitResolve(exitCode);
  };

  worker.postMessage({ lengthBuffer, valueBuffer, js: pidWorldJS, wasmUrl, args, wasmModule });

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorldToHost & { type?: string; f?: string };
    const handler = msg.type ? handlers[msg.type] : undefined;
    const func = msg.f ? funcs[msg.f] : undefined;
    if (handler) handler(msg);
    else if (func) func(msg as Record<string, unknown>, send);
    else send({});
  };

  return {
    pid,
    run: (js: string) => new Promise<void>((resolve) => {
      queue.push(js.trim());
      if (queueResolve) queueResolve();
      handlers.done = () => { send({}); delete handlers.done; resolve(); };
    }),
    dispatch: (js: string) => { dispatchQueue.push(js); if (queueResolve) queueResolve(); },
    terminate: async () => { worker.terminate(); exitResolve(1); return 1; },
    exited,
  };
};
