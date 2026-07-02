import { nodeFs } from './node-fs';
import { nodePath } from './node-path';
import { nodeChildProcess } from './node-child-process';
import { nodeEvents, EventEmitter } from './node-events';
import { nodeBuffer, Buffer } from './node-buffer';
import { nodeProcess } from './node-process';
import { codes, isNodeError } from './node-errors';
import {
  errnoTable, signalTable, fsConstants, osConstants, priorityConstants, dlopenConstants,
  signalToName, nameToSignal, errnoToName, nameToErrno, defaultSignalAction,
} from './node-constants';
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
import { nodeConsole, Console } from './node-console';
import { nodePerfHooks } from './node-perf-hooks';
import { nodeTty } from './node-tty';
import { nodeVm } from './node-vm';
import { nodeReadline } from './node-readline';
import { nodeRepl } from './node-repl';
import { nodeCluster } from './node-cluster';
import { nodeWorkerThreads } from './node-worker-threads';
import { nodeSourceMapSupport } from './node-sourcemap-support';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/') || '/';

const nodeErrors = {
  codes,
  isNodeError,
};

const nodeConstants = {
  errno: errnoTable,
  signals: signalTable,
  fs: fsConstants,
  os: osConstants,
  priority: priorityConstants,
  dlopen: dlopenConstants,
  signalToName,
  nameToSignal,
  errnoToName,
  nameToErrno,
  defaultSignalAction,
};

export const installRequire = (): void => {
  const cache = new Map<string, { exports: unknown }>();

  const builtins: Record<string, unknown> = {
    'node:fs': nodeFs, 'fs': nodeFs,
    'node:path': nodePath, 'path': nodePath,
    'node:child_process': nodeChildProcess, 'child_process': nodeChildProcess,
    'node:events': nodeEvents, 'events': nodeEvents,
    'node:buffer': nodeBuffer, 'buffer': nodeBuffer,
    'node:process': nodeProcess, 'process': nodeProcess,
    'node:os': nodeOs, 'os': nodeOs,
    'node:util': nodeUtil, 'util': nodeUtil,
    'node:crypto': nodeCrypto, 'crypto': nodeCrypto,
    'node:url': nodeUrl, 'url': nodeUrl,
    'node:querystring': nodeQuerystring, 'querystring': nodeQuerystring,
    'node:string_decoder': nodeStringDecoder, 'string_decoder': nodeStringDecoder,
    'node:assert': nodeAssert, 'assert': nodeAssert,
    'node:assert/strict': (nodeAssert as { strict: unknown }).strict,
    'assert/strict': (nodeAssert as { strict: unknown }).strict,
    'node:timers': nodeTimers, 'timers': nodeTimers,
    'node:timers/promises': nodeTimersPromises, 'timers/promises': nodeTimersPromises,
    'node:async_hooks': nodeAsyncHooks, 'async_hooks': nodeAsyncHooks,
    'node:stream': nodeStream, 'stream': nodeStream,
    'node:dns': nodeDns, 'dns': nodeDns,
    'node:dns/promises': nodeDns.promises, 'dns/promises': nodeDns.promises,
    'node:net': nodeNet, 'net': nodeNet,
    'node:http': nodeHttp, 'http': nodeHttp,
    'node:https': nodeHttp, 'https': nodeHttp,
    'node:zlib': nodeZlib, 'zlib': nodeZlib,
    'node:console': nodeConsole, 'console': nodeConsole,
    'node:perf_hooks': nodePerfHooks, 'perf_hooks': nodePerfHooks,
    'node:tty': nodeTty, 'tty': nodeTty,
    'node:vm': nodeVm, 'vm': nodeVm,
    'node:readline': nodeReadline, 'readline': nodeReadline,
    'node:repl': nodeRepl, 'repl': nodeRepl,
    'node:readline/promises': nodeReadline.promises, 'readline/promises': nodeReadline.promises,
    'node:cluster': nodeCluster, 'cluster': nodeCluster,
    'node:worker_threads': nodeWorkerThreads, 'worker_threads': nodeWorkerThreads,
    'source-map-support': nodeSourceMapSupport, '@cspotcode/source-map-support': nodeSourceMapSupport,
    'node:fs/promises': null, 'fs/promises': null, // wired below from nodeFs.promises
    '__dusk_errors__': nodeErrors,
    '__dusk_constants__': nodeConstants,
  };
  builtins['node:fs/promises'] = (nodeFs as { promises: unknown }).promises;
  builtins['fs/promises'] = (nodeFs as { promises: unknown }).promises;

  // Expose Console as a global type for code that does `new Console(...)`
  if ((globalThis as Record<string, unknown>)['Console'] === undefined) {
    (globalThis as Record<string, unknown>)['Console'] = Console;
  }

  // expose Buffer + EventEmitter as globals (matches Node)
  const g = globalThis as Record<string, unknown>;
  if (g['Buffer'] === undefined) g['Buffer'] = Buffer;
  if (g['EventEmitter'] === undefined) g['EventEmitter'] = EventEmitter;

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
