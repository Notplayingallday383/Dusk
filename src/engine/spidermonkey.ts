const SM_DATA_URL = 'https://mozilla-spidermonkey.github.io/sm-wasi-demo/data.json';

export interface EngineSource {
  wasmUrl: string;
  args: string[];
}

let cached: EngineSource | undefined;

export const resolveSpiderMonkey = async (): Promise<EngineSource> => {
  if (cached) return cached;
  const data = (await (await fetch(SM_DATA_URL)).json()) as Array<{ url: string }>;
  const first = data[0];
  if (!first) throw new Error('SpiderMonkey WASI demo data.json was empty');
  cached = { wasmUrl: first.url, args: ['js.wasm', '-f', '/input.js'] };
  return cached;
};
