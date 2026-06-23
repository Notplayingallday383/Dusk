import { build } from 'esbuild';
import type { Plugin } from 'vite';

export const worldSource = (): Plugin => ({
  name: 'world-source',
  async transform(code: string, id: string) {
    if (!id.includes('?worldsrc')) return null;
    const path = id.replace(/\?worldsrc$/, '');
    const result = await build({
      entryPoints: [path],
      bundle: true,
      format: 'iife',
      platform: 'neutral',
      write: false,
      logLevel: 'silent',
    });
    const js = result.outputFiles[0]!.text;
    return { code: `export default ${JSON.stringify(js)};`, map: null };
  },
});
