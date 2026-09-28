import { expect, test } from 'vitest';
import { createEsbuildWasmAdapter, initializeEsbuildWasm } from '../src/worker/esbuild-wasm-adapter';

test('initializes esbuild only when a Vite API is called', async () => {
  let initializations = 0;
  const api = createEsbuildWasmAdapter({
    browserUrl: 'unused-browser-url',
    wasmUrl: 'unused-wasm-url',
    initialize: async () => {
      initializations++;
      return {
        initialize: async () => {},
        context: async () => ({}),
        build: async () => ({}),
        transform: async () => ({ code: '' }),
        formatMessages: async () => [],
        version: '0.21.5',
      };
    },
  });

  expect(initializations).toBe(0);
  await expect((api.transform as (source: string) => Promise<unknown>)('const value = 1')).resolves.toEqual({ code: '' });
  expect(initializations).toBe(1);
  expect(api.version).toBe('0.21.5');
});

test('initializes the official UMD browser API after a dynamic import', async () => {
  const initializationKey = '__DUSK_ESBUILD_TEST_INITIALIZATION__';
  const browserUrl = `data:text/javascript,${encodeURIComponent(`
    const api = {
      initialize(options) { globalThis.${initializationKey} = options; return Promise.resolve(); },
      context() {}, build() {}, transform() {}, formatMessages() {}, version: '0.21.5'
    };
    globalThis.esbuild = api;
  `)}`;

  await initializeEsbuildWasm(browserUrl, 'fixture-wasm-url');

  expect((globalThis as Record<string, unknown>)[initializationKey]).toEqual({
    wasmURL: 'fixture-wasm-url',
    worker: true,
  });
  delete (globalThis as Record<string, unknown>)[initializationKey];
  delete (globalThis as Record<string, unknown>).esbuild;
});
