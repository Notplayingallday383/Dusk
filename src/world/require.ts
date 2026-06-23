import { nodeFs } from './node-fs';
import { nodePath } from './node-path';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/') || '/';

export const installRequire = (): void => {
  const cache = new Map<string, { exports: unknown }>();

  const builtins: Record<string, unknown> = {
    'node:fs': nodeFs, 'fs': nodeFs,
    'node:path': nodePath, 'path': nodePath,
  };

  const makeRequire = (fromDir: string) => (request: string): unknown => {
    if (request in builtins) return builtins[request];
    const resolved = call('module.resolve', { request, fromDir }) as string;
    const cached = cache.get(resolved);
    if (cached) return cached.exports;

    const source = call('module.readSource', { path: resolved }) as string;
    const module = { exports: {} as unknown };
    cache.set(resolved, module);

    if (resolved.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports; }

    const dir = dirOf(resolved);
    const fn = (0, eval)(
      '(function(exports, require, module, __filename, __dirname){' + source + '\n})'
    ) as (e: unknown, r: unknown, m: unknown, fn: string, dn: string) => void;
    fn(module.exports, makeRequire(dir), module, resolved, dir);
    return module.exports;
  };

  (globalThis as Record<string, unknown>)['require'] = makeRequire('/');
};
