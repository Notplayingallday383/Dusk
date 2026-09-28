import { expect, test } from 'vitest';

test('native worker HMR transform strips Vite client injection from the native worker graph only', async () => {
  const modulePath = '../vite-native-worker-hmr';
  const loaded = await import(/* @vite-ignore */ modulePath).catch(() => undefined) as {
    nativeWorkerWithoutHmr?: () => {
      transform?: (code: string, id: string) => { code: string; map: null } | null;
      configResolved?: (config: { plugins: unknown[] }) => void;
    };
  } | undefined;

  expect(loaded?.nativeWorkerWithoutHmr).toBeTypeOf('function');
  if (!loaded?.nativeWorkerWithoutHmr) return;

  const plugin = loaded.nativeWorkerWithoutHmr();
  const transform = plugin.transform!;
  const hmrInjected = 'import { createHotContext as __vite__createHotContext } from "/@vite/client";import.meta.hot = __vite__createHotContext("/src/worker/native-loader.ts");self.addEventListener("message", () => {});';

  expect(transform(hmrInjected, '/project/src/worker/native-loader.ts?worker_file&type=module')).toEqual({
    code: 'self.addEventListener("message", () => {});',
    map: null,
  });
  expect(transform(hmrInjected, '/project/src/worker/wasi-loader.ts?worker_file&type=module')).toEqual({
    code: 'self.addEventListener("message", () => {});',
    map: null,
  });
  expect(transform(hmrInjected, '/project/src/worker/esbuild-wasm-adapter.ts')).toEqual({
    code: 'self.addEventListener("message", () => {});',
    map: null,
  });
  const viteInjectedDynamicImport = 'import { injectQuery as __vite__injectQuery } from "/@vite/client";const api = import(__vite__injectQuery(browserUrl, \'import\'));';
  expect(transform(viteInjectedDynamicImport, '/project/src/worker/esbuild-wasm-adapter.ts')).toEqual({
    code: 'const api = import(browserUrl);',
    map: null,
  });
  expect(transform(hmrInjected, '/project/src/host/engine-instance.ts')).toBeNull();

  expect(plugin.configResolved).toBeTypeOf('function');
  if (!plugin.configResolved) return;

  const importAnalysis = { name: 'vite:import-analysis' };
  const plugins = [plugin, importAnalysis];
  plugin.configResolved({ plugins } as never);
  expect(plugins).toEqual([importAnalysis, plugin]);
});
