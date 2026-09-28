import { SERIAL_RES_SIZE, type BufferInit } from '../protocol/messages';
import { createEsbuildWasmAdapter } from './esbuild-wasm-adapter';

const decoder = new TextDecoder();
// Host IPC must remain available while guest code runs under just-bash's
// defense context, which deliberately guards globalThis.Atomics.
const hostAtomics = Atomics;
let syncRpcSeq = 0;

self.addEventListener('message', async (event: MessageEvent) => {
  const init = event.data as Partial<BufferInit> & { pid?: number };
  if (!init.lengthBuffer || !init.valueBuffer || init.js === undefined) return;

  const length = new Int32Array(init.lengthBuffer);
  const value = new Uint8Array(init.valueBuffer);
  const shell = globalThis as Record<string, unknown>;
  let response = '';

  shell['__DUSK_NATIVE_WORKER__'] = true;
  shell['print'] = (text: unknown): void => {
    let message: unknown;
    try { message = JSON.parse(String(text)); } catch { console.warn(text); return; }
    hostAtomics.store(length, 0, 0);
    const requestSeq = ++syncRpcSeq;
    self.postMessage({ ...(message as Record<string, unknown>), syncRpcSeq: requestSeq });
    hostAtomics.wait(length, 0, 0, Infinity);
    const size = hostAtomics.load(length, 0);
    if (size > SERIAL_RES_SIZE) throw new Error('IPC response exceeds SERIAL_RES_SIZE limit');
    response = decoder.decode(value.slice(0, size));
    self.postMessage({ type: 'sync-rpc-consumed', syncRpcSeq: requestSeq });
  };
  shell['readline'] = (): string => 'A';
  shell['os'] = {
    file: {
      readFile(path: string): string {
        if (path !== '/comm') throw new Error(`native worker cannot read ${path}`);
        return response;
      },
    },
  };
  try {
    if (init.esbuildBrowserUrl && init.esbuildWasmUrl) {
      shell['__DUSK_ESBUILD_WASM__'] = createEsbuildWasmAdapter({
        browserUrl: init.esbuildBrowserUrl,
        wasmUrl: init.esbuildWasmUrl,
      });
    }
    if (init.rollupBrowserWasmBytes) {
      shell['__DUSK_ROLLUP_BROWSER_WASM_BYTES__'] = init.rollupBrowserWasmBytes;
    }
    // The bundled world is an IIFE and installs itself against the Worker global.
    (0, eval)(`const __DUSK_PID__ = ${init.pid ?? 0};\n${init.js}`);
    self.addEventListener('message', (evalEvent: MessageEvent) => {
      const evalMessage = evalEvent.data as { type?: string; js?: string; primary?: boolean };
      if (evalMessage.type !== 'eval' || typeof evalMessage.js !== 'string') return;
      const enqueue = (globalThis as Record<string, unknown>)['__duskEnqueueEval'];
      if (typeof enqueue === 'function') {
        (enqueue as (js: string, primary: boolean) => void)(evalMessage.js, evalMessage.primary === true);
      }
    });
  } catch (error) {
    self.postMessage({ f: 'console.error', args: [String(error)] });
  }
}, { once: true });
