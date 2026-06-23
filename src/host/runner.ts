import { SERIAL_RES_SIZE, type WorldToHost } from '../protocol/messages';
import { resolveSpiderMonkey } from '../engine/spidermonkey';

export type SendFn = (msg: unknown) => void;
export type FuncFn = (msg: Record<string, unknown>, send: SendFn) => void;
export type FuncTable = Record<string, FuncFn>;

export interface DuskRunner {
  run(js: string): Promise<void>;
  dispatch(js: string): void;
  stop(): void;
}

export const createRunner = async (funcs: FuncTable = {}): Promise<DuskRunner> => {
  if (!crossOriginIsolated) throw new Error('DuskJS requires cross-origin isolation (SharedArrayBuffer)');

  const { wasmUrl, args } = await resolveSpiderMonkey();
  const worldJS = (await import('../world/world.ts?worldsrc')).default;

  const worker = new Worker(new URL('../worker/wasi-loader.ts', import.meta.url), { type: 'module' });

  const lengthBuffer = new SharedArrayBuffer(4);
  const lengthTyped = new Int32Array(lengthBuffer);
  const valueBuffer = new SharedArrayBuffer(SERIAL_RES_SIZE);
  const valueTyped = new Uint8Array(valueBuffer);
  const encoder = new TextEncoder();

  const queue: string[] = [];
  const dispatchQueue: string[] = [];
  let queueResolve: (() => void) | null = null;
  const handlers: Record<string, (msg: WorldToHost) => void> = {};

  const send: SendFn = (msg) => {
    const bytes = encoder.encode(JSON.stringify(msg));
    for (let i = 0; i < bytes.length; i++) Atomics.store(valueTyped, i, bytes[i]!);
    Atomics.store(lengthTyped, 0, bytes.length);
    Atomics.notify(lengthTyped, 0);
  };

  handlers.wait = async () => {
    if (dispatchQueue.length > 0) { send({ type: 'eval', js: dispatchQueue.shift() }); return; }
    if (queue.length === 0) await new Promise<void>((res) => { queueResolve = res; });
    queueResolve = null;
    send({ type: 'eval', js: queue.pop() });
  };

  worker.postMessage({ lengthBuffer, valueBuffer, js: worldJS, wasmUrl, args });

  worker.onmessage = (e: MessageEvent) => {
    const msg = e.data as WorldToHost & { type?: string; f?: string };
    const handler = msg.type ? handlers[msg.type] : undefined;
    const func = msg.f ? funcs[msg.f] : undefined;
    if (handler) handler(msg);
    else if (func) func(msg as Record<string, unknown>, send);
    else send({});
  };

  return {
    run: (js: string) => new Promise<void>((resolve) => {
      queue.push(js.trim());
      if (queueResolve) queueResolve();
      handlers.done = () => { send({}); delete handlers.done; resolve(); };
    }),
    dispatch: (js: string) => { dispatchQueue.push(js); if (queueResolve) queueResolve(); },
    stop: () => { worker.onmessage = null; worker.terminate(); },
  };
};
