import { test, expect } from 'vitest';
import source from '../src/host/engine-instance.ts?raw';

test('loads the Rollup browser WASM through a bundler asset URL', () => {
  expect(source).toContain("import rollupBrowserWasmUrl from './rollup-browser/bindings_wasm_bg.wasm?url';");
  expect(source).toContain('fetch(rollupBrowserWasmUrl)');
  expect(source).not.toContain("new URL('./rollup-browser/bindings_wasm_bg.wasm', import.meta.url)");
});
