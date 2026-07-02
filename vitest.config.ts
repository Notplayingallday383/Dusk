import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import { worldSource } from './vite-world-source';
import pkg from './package.json';

export default defineConfig({
  server: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
  plugins: [worldSource()],
  worker: { format: 'es' },
  optimizeDeps: { include: ['@wasmer/wasi', '@wasmer/wasi/lib/bindings/browser', '@wasmer/wasmfs', 'buffer', '@terbiumos/tfs/browser'], exclude: ['libcurl.js'] },
  define: {
    __DUSK_VERSION__: JSON.stringify(pkg.version),
  },
  test: {
    browser: {
      enabled: true,
      provider: playwright(),
      instances: [{ browser: 'chromium' }],
      headless: true,
    },
    include: ['test/**/*.test.ts'],
  },
});
