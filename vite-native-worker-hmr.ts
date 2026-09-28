import type { Plugin, ResolvedConfig } from 'vite';

const nativeWorkerEntrypointPaths = [
  '/src/worker/native-loader.ts',
  '/src/worker/wasi-loader.ts',
  '/src/worker/esbuild-wasm-adapter.ts',
];
const viteHmrClientInjection = /import\s*\{\s*createHotContext\s+as\s+__vite__createHotContext\s*\}\s*from\s*["'][^"']*@vite\/client["'];?\s*import\.meta\.hot\s*=\s*__vite__createHotContext\([^;]*\);?\s*/g;
const viteDynamicImportInjection = /import\s*\{\s*injectQuery\s+as\s+__vite__injectQuery\s*\}\s*from\s*["'][^"']*@vite\/client["'];?\s*/g;
const viteDynamicImportCall = /__vite__injectQuery\(([^,]+),\s*["']import["']\)/g;

export const nativeWorkerWithoutHmr = (): Plugin => {
  const plugin: Plugin = {
  name: 'native-worker-without-hmr',
  apply: 'serve',
  enforce: 'post',
  configResolved(config: ResolvedConfig) {
    // Vite appends import analysis after user post plugins, but that is where it
    // injects the HMR client. Run immediately after it to remove only this worker's injection.
    const plugins = config.plugins as Plugin[];
    const currentIndex = plugins.indexOf(plugin);
    const importAnalysisIndex = plugins.findIndex(({ name }) => name === 'vite:import-analysis');
    if (currentIndex === -1 || importAnalysisIndex === -1 || currentIndex === importAnalysisIndex + 1) return;

    plugins.splice(currentIndex, 1);
    plugins.splice(importAnalysisIndex + 1, 0, plugin);
  },
  transform(code, id) {
    const path = id.split('?', 1)[0]!.replaceAll('\\', '/');
    if (!nativeWorkerEntrypointPaths.some((entrypoint) => path.endsWith(entrypoint))) return null;

    const transformed = code
      .replace(viteHmrClientInjection, '')
      .replace(viteDynamicImportInjection, '')
      .replace(viteDynamicImportCall, '$1');
    return transformed === code ? null : { code: transformed, map: null };
  },
  };
  return plugin;
};
