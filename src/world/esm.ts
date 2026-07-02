import { nodeFs } from './node-fs';
import { nodePath } from './node-path';
import { nodeChildProcess } from './node-child-process';
import { nodeEvents } from './node-events';
import { nodeBuffer } from './node-buffer';
import { nodeProcess } from './node-process';
import { nodeOs } from './node-os';
import { nodeUtil } from './node-util';
import { nodeCrypto } from './node-crypto';
import { nodeUrl } from './node-url';
import { nodeQuerystring } from './node-querystring';
import { nodeStringDecoder } from './node-string-decoder';
import { nodeAssert } from './node-assert';
import { nodeTimers, nodeTimersPromises } from './node-timers';
import { nodeAsyncHooks } from './node-async-hooks';
import { nodeStream } from './node-stream';
import { nodeDns } from './node-dns';
import { nodeNet } from './node-net';
import { nodeHttp } from './node-http';
import { nodeZlib } from './node-zlib';
import { nodeConsole } from './node-console';
import { nodePerfHooks } from './node-perf-hooks';
import { nodeTty } from './node-tty';
import { nodeVm } from './node-vm';
import { nodeReadline } from './node-readline';
import { nodeRepl } from './node-repl';
import { nodeCluster } from './node-cluster';
import { nodeWorkerThreads } from './node-worker-threads';

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
    'node:child_process': builtinNs(nodeChildProcess),
    'child_process': builtinNs(nodeChildProcess),
    'node:events': builtinNs(nodeEvents as unknown as Record<string, unknown>),
    'events': builtinNs(nodeEvents as unknown as Record<string, unknown>),
    'node:buffer': builtinNs(nodeBuffer as unknown as Record<string, unknown>),
    'buffer': builtinNs(nodeBuffer as unknown as Record<string, unknown>),
    'node:process': builtinNs(nodeProcess as unknown as Record<string, unknown>),
    'process': builtinNs(nodeProcess as unknown as Record<string, unknown>),
    'node:os': builtinNs(nodeOs as unknown as Record<string, unknown>),
    'os': builtinNs(nodeOs as unknown as Record<string, unknown>),
    'node:util': builtinNs(nodeUtil as unknown as Record<string, unknown>),
    'util': builtinNs(nodeUtil as unknown as Record<string, unknown>),
    'node:crypto': builtinNs(nodeCrypto as unknown as Record<string, unknown>),
    'crypto': builtinNs(nodeCrypto as unknown as Record<string, unknown>),
    'node:url': builtinNs(nodeUrl as unknown as Record<string, unknown>),
    'url': builtinNs(nodeUrl as unknown as Record<string, unknown>),
    'node:querystring': builtinNs(nodeQuerystring as unknown as Record<string, unknown>),
    'querystring': builtinNs(nodeQuerystring as unknown as Record<string, unknown>),
    'node:string_decoder': builtinNs(nodeStringDecoder as unknown as Record<string, unknown>),
    'string_decoder': builtinNs(nodeStringDecoder as unknown as Record<string, unknown>),
    'node:assert': builtinNs(nodeAssert as unknown as Record<string, unknown>),
    'assert': builtinNs(nodeAssert as unknown as Record<string, unknown>),
    'node:timers': builtinNs(nodeTimers as unknown as Record<string, unknown>),
    'timers': builtinNs(nodeTimers as unknown as Record<string, unknown>),
    'node:timers/promises': builtinNs(nodeTimersPromises as unknown as Record<string, unknown>),
    'timers/promises': builtinNs(nodeTimersPromises as unknown as Record<string, unknown>),
    'node:async_hooks': builtinNs(nodeAsyncHooks as unknown as Record<string, unknown>),
    'async_hooks': builtinNs(nodeAsyncHooks as unknown as Record<string, unknown>),
    'node:stream': builtinNs(nodeStream as unknown as Record<string, unknown>),
    'stream': builtinNs(nodeStream as unknown as Record<string, unknown>),
    'node:dns': builtinNs(nodeDns as unknown as Record<string, unknown>),
    'dns': builtinNs(nodeDns as unknown as Record<string, unknown>),
    'node:net': builtinNs(nodeNet as unknown as Record<string, unknown>),
    'net': builtinNs(nodeNet as unknown as Record<string, unknown>),
    'node:http': builtinNs(nodeHttp as unknown as Record<string, unknown>),
    'http': builtinNs(nodeHttp as unknown as Record<string, unknown>),
    'node:https': builtinNs(nodeHttp as unknown as Record<string, unknown>),
    'https': builtinNs(nodeHttp as unknown as Record<string, unknown>),
    'node:zlib': builtinNs(nodeZlib as unknown as Record<string, unknown>),
    'zlib': builtinNs(nodeZlib as unknown as Record<string, unknown>),
    'node:console': builtinNs(nodeConsole as unknown as Record<string, unknown>),
    'console': builtinNs(nodeConsole as unknown as Record<string, unknown>),
    'node:perf_hooks': builtinNs(nodePerfHooks as unknown as Record<string, unknown>),
    'perf_hooks': builtinNs(nodePerfHooks as unknown as Record<string, unknown>),
    'node:tty': builtinNs(nodeTty as unknown as Record<string, unknown>),
    'tty': builtinNs(nodeTty as unknown as Record<string, unknown>),
    'node:vm': builtinNs(nodeVm as unknown as Record<string, unknown>),
    'vm': builtinNs(nodeVm as unknown as Record<string, unknown>),
    'node:readline': builtinNs(nodeReadline as unknown as Record<string, unknown>),
    'readline': builtinNs(nodeReadline as unknown as Record<string, unknown>),
    'node:repl': builtinNs(nodeRepl as unknown as Record<string, unknown>),
    'repl': builtinNs(nodeRepl as unknown as Record<string, unknown>),
    'node:cluster': builtinNs(nodeCluster as unknown as Record<string, unknown>),
    'cluster': builtinNs(nodeCluster as unknown as Record<string, unknown>),
    'node:worker_threads': builtinNs(nodeWorkerThreads as unknown as Record<string, unknown>),
    'worker_threads': builtinNs(nodeWorkerThreads as unknown as Record<string, unknown>),
    'node:fs/promises': builtinNs((nodeFs as { promises: Record<string, unknown> }).promises),
    'fs/promises': builtinNs((nodeFs as { promises: Record<string, unknown> }).promises),
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
