import { defineConfig } from 'vite';
import { worldSource } from './vite-world-source';
import pkg from './package.json';

const crossOriginIsolation = {
  name: 'cross-origin-isolation',
  configureServer(server: { middlewares: { use: (fn: (req: unknown, res: { setHeader: (k: string, v: string) => void }, next: () => void) => void) => void } }) {
    server.middlewares.use((_req, res, next) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  },
};

export default defineConfig({
  plugins: [crossOriginIsolation, worldSource()],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['libcurl.js'] },
  server: { allowedHosts: ['ddxdevtemp.ampscat.dev'] },
  define: {
    __DUSK_VERSION__: JSON.stringify(pkg.version),
  },
});
