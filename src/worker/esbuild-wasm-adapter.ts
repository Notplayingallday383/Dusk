type EsbuildBrowserApi = {
  initialize(options: { wasmURL: string; worker: true }): Promise<void>;
  context: unknown;
  build: unknown;
  transform: unknown;
  formatMessages: unknown;
  version: unknown;
};

let apiPromise: Promise<EsbuildBrowserApi> | undefined;

type Initialize = () => Promise<EsbuildBrowserApi>;

interface EsbuildWasmAdapterOptions {
  browserUrl: string;
  wasmUrl: string;
  initialize?: Initialize;
}

export const initializeEsbuildWasm = (browserUrl: string, wasmUrl: string): Promise<EsbuildBrowserApi> => {
  if (!apiPromise) {
    apiPromise = import(/* @vite-ignore */ browserUrl).then(async (namespace) => {
      const api = [
        namespace['module.exports'],
        namespace.default,
        namespace,
        (globalThis as Record<string, unknown>).esbuild,
      ].find((candidate): candidate is EsbuildBrowserApi =>
        typeof (candidate as { initialize?: unknown } | undefined)?.initialize === 'function',
      );
      if (!api) throw new Error('esbuild-wasm browser API is unavailable');
      await api.initialize({ wasmURL: wasmUrl, worker: true });
      return api;
    });
  }
  return apiPromise;
};

export const createEsbuildWasmAdapter = ({
  browserUrl,
  wasmUrl,
  initialize = () => initializeEsbuildWasm(browserUrl, wasmUrl),
}: EsbuildWasmAdapterOptions): Record<string, unknown> => {
  let api: Promise<EsbuildBrowserApi> | undefined;
  const load = (): Promise<EsbuildBrowserApi> => api ??= initialize();
  const call = (method: 'context' | 'build' | 'transform' | 'formatMessages') =>
    (...args: unknown[]): Promise<unknown> => load().then((loaded) => {
      const fn = loaded[method] as (...parameters: unknown[]) => unknown;
      return fn(...args);
    });
  return {
    context: call('context'),
    build: call('build'),
    transform: call('transform'),
    formatMessages: call('formatMessages'),
    version: '0.21.5',
  };
};
