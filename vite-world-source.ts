import { build } from 'esbuild';
import type { Plugin } from 'vite';
import pkg from './package.json';

// Aliases for third-party modules that don't resolve inside the DuskJS engine.
// The just-bash browser bundle imports node:zlib (for gzip/gunzip/zcat) and
// turndown (for html-to-markdown). Both are unavailable in-engine; provide
// runtime-throwing shims so the bundle links but calling those specific
// commands surfaces a clear error message.
// URLs constructed against import.meta.url so this works under bundler + ESM.
const shimUrl = (name: string): string => new URL('./src/binaries/jsh/shims/' + name, import.meta.url).pathname;
const ENGINE_ALIASES: Record<string, string> = {
  'node:zlib': shimUrl('zlib-stub.js'),
  'node:dns': shimUrl('dns-stub.js'),
  turndown: shimUrl('turndown-stub.js'),
};

export const worldSource = (): Plugin => ({
  name: 'world-source',
  async transform(code: string, id: string) {
    if (!id.includes('?worldsrc')) return null;
    const path = id.replace(/\?worldsrc$/, '');
    const result = await build({
      entryPoints: [path],
      bundle: true,
      format: 'iife',
      // Browser platform so node_modules resolution picks up deps like
      // sprintf-js (used by just-bash's printf command). Truly-unresolvable
      // node:* imports go through the alias map above.
      platform: 'browser',
      write: false,
      logLevel: 'silent',
      define: {
        __DUSK_VERSION__: JSON.stringify(pkg.version),
      },
      alias: ENGINE_ALIASES,
    });
    const js = result.outputFiles[0]!.text;
    return { code: `export default ${JSON.stringify(js)};`, map: null };
  },
});
