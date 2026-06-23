import './polys';
import { WASI } from '@wasmer/wasi';
import browserBindings from '@wasmer/wasi/lib/bindings/browser';
import { WasmFs } from '@wasmer/wasmfs';
import { SERIAL_RES_SIZE, type BufferInit } from '../protocol/messages';

const decoder = new TextDecoder('utf8');
const decodeBuffer = new Uint8Array(SERIAL_RES_SIZE);

let lengthTyped: Int32Array | undefined;
let valueTyped: Uint8Array | undefined;
let js: string | undefined;
let wasmUrl: string | undefined;
let args: string[] | undefined;

const ready = new Promise<void>((resolve) => {
  self.addEventListener('message', (e: MessageEvent) => {
    const d = e.data as Partial<BufferInit> & { wasmUrl?: string; args?: string[] };
    if (!lengthTyped && d.lengthBuffer && d.valueBuffer && d.wasmUrl && d.args) {
      lengthTyped = new Int32Array(d.lengthBuffer);
      valueTyped = new Uint8Array(d.valueBuffer);
      js = d.js;
      wasmUrl = d.wasmUrl;
      args = d.args;
      resolve();
    }
  });
});

const start = async (): Promise<void> => {
  await ready;
  if (!lengthTyped || !valueTyped || js === undefined || !wasmUrl || !args)
    throw new Error('worker not initialized');

  const wasmModule = await WebAssembly.compileStreaming(fetch(wasmUrl));
  const wasmFs = new WasmFs();
  const randomFillSync = <T>(buffer: T, offset = 0, size?: number): T => {
    const view = buffer as unknown as ArrayBufferView;
    const u8 = new Uint8Array(view.buffer, view.byteOffset + offset, size ?? view.byteLength - offset);
    crypto.getRandomValues(u8);
    return buffer;
  };

  const wasi = new WASI({
    args,
    preopens: { '/': '/' },
    env: {},
    bindings: { ...browserBindings, randomFillSync, fs: wasmFs.fs },
  });

  const instance = await WebAssembly.instantiate(wasmModule, wasi.getImports(wasmModule));

  wasmFs.fs.writeFileSync('/input.js', js);

  const fds = (wasmFs as { volume: { fds: Record<number, { position: number }> } }).volume.fds;
  if (fds[1]) fds[1].position = 0;
  if (fds[2]) fds[2].position = 0;

  wasmFs.fs.writeFileSync('/comm', '');
  wasmFs.fs.writeFileSync('/dev/stdin', '');
  wasmFs.fs.writeFileSync('/dev/stdout', '');
  wasmFs.fs.writeFileSync('/dev/stderr', '');

  let lastStdout = '';
  wasmFs.fs.watch('/dev/stdout', {}, () => {
    const stdout = wasmFs.fs.readFileSync('/dev/stdout', 'utf8') as string;
    const newStdout = stdout.slice(lastStdout.length);
    lastStdout = stdout;
    if (!newStdout) return;

    for (const line of newStdout.split('\n')) {
      if (!line) continue;
      let msg: unknown;
      try { msg = JSON.parse(line); } catch { console.warn(line); continue; }

      Atomics.store(lengthTyped!, 0, 0);
      self.postMessage(msg);
      Atomics.wait(lengthTyped!, 0, 0, Infinity);

      const length = Atomics.load(lengthTyped!, 0);
      for (let i = 0; i < length; i++) decodeBuffer[i] = Atomics.load(valueTyped!, i);
      const replyRaw = decoder.decode(decodeBuffer.slice(0, length));

      let reply = replyRaw;
      if (reply.startsWith('{"type":"eval')) reply = 'JS|' + (JSON.parse(replyRaw) as { js: string }).js;

      wasmFs.fs.writeFileSync('/comm', reply + '\n');
      wasmFs.fs.appendFileSync('/dev/stdin', 'A\n');
    }
  });

  try { wasi.start(instance); } catch (e) { console.error(e); }
};

void start();
