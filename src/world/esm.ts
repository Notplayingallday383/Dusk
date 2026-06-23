import { nodeFs } from './node-fs';
import { nodePath } from './node-path';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/') || '/';

const transpile = (source: string): string => {
  let s = source;
  s = s.replace(/\bimport\s*\(/g, '__import__(');
  s = s.replace(/export\s+default\s+/g, 'exports.default = ');
  s = s.replace(/export\s+const\s+(\w+)\s*=/g, 'exports.$1 =');
  s = s.replace(/export\s+let\s+(\w+)\s*=/g, 'exports.$1 =');
  s = s.replace(/export\s+var\s+(\w+)\s*=/g, 'exports.$1 =');
  s = s.replace(/export\s+function\s+(\w+)/g, 'exports.$1 = function $1');
  s = s.replace(/export\s+class\s+(\w+)/g, 'exports.$1 = class $1');
  s = s.replace(/export\s*\{([^}]*)\}/g, (_m, names: string) =>
    names
      .split(',')
      .map((n) => {
        const t = n.trim();
        if (!t) return '';
        const parts = t.split(/\s+as\s+/);
        const local = parts[0]!.trim();
        const exported = (parts[1] ?? parts[0]!).trim();
        return `exports.${exported} = ${local};`;
      })
      .join(''));
  return s;
};

export const installESM = (): void => {
  const cache = new Map<string, Record<string, unknown>>();

  const builtinNs = (mod: Record<string, unknown>): Record<string, unknown> => ({ ...mod, default: mod });
  const builtins: Record<string, Record<string, unknown>> = {
    'node:fs': builtinNs(nodeFs as unknown as Record<string, unknown>),
    'fs': builtinNs(nodeFs as unknown as Record<string, unknown>),
    'node:path': builtinNs(nodePath as unknown as Record<string, unknown>),
    'path': builtinNs(nodePath as unknown as Record<string, unknown>),
  };

  const importModule = (request: string, fromDir: string): Record<string, unknown> => {
    const builtin = builtins[request];
    if (builtin) return builtin;
    const resolved = call('module.resolve', { request, fromDir }) as string;
    const cached = cache.get(resolved);
    if (cached) return cached;

    const source = call('module.readSource', { path: resolved }) as string;
    const exports: Record<string, unknown> = {};
    cache.set(resolved, exports);
    if (resolved.endsWith('.json')) { exports['default'] = JSON.parse(source); return exports; }

    const dir = dirOf(resolved);
    const localImport = (req: string): Promise<Record<string, unknown>> =>
      Promise.resolve(importModule(req, dir));
    const fn = (0, eval)(
      '(function(exports, __import__){' + transpile(source) + '\n})'
    ) as (e: Record<string, unknown>, imp: (r: string) => Promise<Record<string, unknown>>) => void;
    fn(exports, localImport);
    return exports;
  };

  (globalThis as Record<string, unknown>)['__import__'] = (request: string): Promise<Record<string, unknown>> =>
    Promise.resolve(importModule(request, '/'));
};
