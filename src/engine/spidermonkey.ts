const SM_DATA_URL = 'https://mozilla-spidermonkey.github.io/sm-wasi-demo/data.json';

export interface EngineSource {
  wasmUrl: string;
  args: string[];
  /**
   * Pre-compiled WebAssembly.Module ready for instantiation.
   * Computed lazily on first call and cached for the lifetime of the page.
   * Subsequent createEngine calls skip the fetch+compile (~150ms saved per spawn).
   */
  wasmModule?: WebAssembly.Module;
}

let cached: EngineSource | undefined;
let compilingPromise: Promise<WebAssembly.Module> | undefined;

export const resolveSpiderMonkey = async (): Promise<EngineSource> => {
  if (cached && cached.wasmModule) return cached;
  if (!cached) {
    const data = (await (await fetch(SM_DATA_URL)).json()) as Array<{ url: string }>;
    const first = data[0];
    if (!first) throw new Error('SpiderMonkey WASI demo data.json was empty');
    cached = { wasmUrl: first.url, args: ['js.wasm', '-f', '/input.js'] };
  }
  // Kick off (or join) compile
  if (!compilingPromise) {
    compilingPromise = WebAssembly.compileStreaming(fetch(cached.wasmUrl)).catch((e) => {
      compilingPromise = undefined;
      throw e;
    });
  }
  cached.wasmModule = await compilingPromise;
  return cached;
};

/**
 * Eagerly start the SpiderMonkey wasm fetch+compile so subsequent createEngine
 * calls can use the cached module immediately. Safe to call multiple times;
 * subsequent calls are no-ops.
 */
export const prewarmEngine = (): void => {
  // Fire-and-forget; resolveSpiderMonkey caches the result.
  void resolveSpiderMonkey();
};
