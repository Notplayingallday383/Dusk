import { nodeFs } from './node-fs';
import { nodePath } from './node-path';
import { nodeChildProcess } from './node-child-process';
import { nodeEvents, EventEmitter, once as eventsOnce, on as eventsOn, setMaxListeners, getEventListeners } from './node-events';
import { nodeBuffer, Buffer } from './node-buffer';
import { nodeProcess } from './node-process';
import { codes, isNodeError } from './node-errors';
import {
  errnoTable, signalTable, fsConstants, osConstants, priorityConstants, dlopenConstants,
  signalToName, nameToSignal, errnoToName, nameToErrno, defaultSignalAction,
} from './node-constants';
import { nodeOs } from './node-os';
import { nodeUtil, types } from './node-util';
import { nodeCrypto } from './node-crypto';
import { nodeUrl } from './node-url';
import { nodeQuerystring } from './node-querystring';
import { nodeStringDecoder } from './node-string-decoder';
import { nodeAssert } from './node-assert';
import { nodeTimers, nodeTimersPromises } from './node-timers';
import { nodeAsyncHooks } from './node-async-hooks';
import { nodeStream, nodeStreamPromises } from './node-stream';
import { nodeDns } from './node-dns';
import { nodeNet } from './node-net';
import { nodeTls } from './node-tls';
import { nodeHttp, nodeHttps } from './node-http';
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
import { nodeModule } from './node-module';

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

const nodeConstantsModule = Object.freeze({
  ...errnoTable,
  ...signalTable,
  ...fsConstants,
  ...osConstants,
  ...priorityConstants,
  ...dlopenConstants,
});

export const installRequire = (): void => {
  const cache = new Map<string, { exports: unknown }>();
  // Node's CommonJS events module is the EventEmitter constructor itself, not
  // the ESM-shaped namespace used by the SystemJS loader.
  const commonJsEvents = Object.assign(EventEmitter, {
    default: EventEmitter,
    once: eventsOnce,
    on: eventsOn,
    setMaxListeners,
    getEventListeners,
  });

  const builtins: Record<string, unknown> = {
    'node:fs': nodeFs, 'fs': nodeFs,
    'node:path': nodePath, 'path': nodePath,
    'node:child_process': nodeChildProcess, 'child_process': nodeChildProcess,
    'node:events': commonJsEvents, 'events': commonJsEvents,
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
    'node:stream/promises': nodeStreamPromises, 'stream/promises': nodeStreamPromises,
    'node:dns': nodeDns, 'dns': nodeDns,
    'node:dns/promises': nodeDns.promises, 'dns/promises': nodeDns.promises,
    'node:net': nodeNet, 'net': nodeNet,
    'node:tls': nodeTls, 'tls': nodeTls,
    'node:http': nodeHttp, 'http': nodeHttp,
    'node:https': nodeHttps, 'https': nodeHttps,
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
    'node:module': nodeModule, 'module': nodeModule,
    'node:util/types': types, 'util/types': types,
    'node:constants': nodeConstantsModule, 'constants': nodeConstantsModule,
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

  const makeRequire = (fromDir: string) => {
    const require = (request: string): unknown => {
      if (request in builtins) return builtins[request];
      const resolvedModule = call('module.resolve', { request, fromDir, mode: 'require' }) as { path: string; format: 'esm' | 'cjs' | 'json' };
      const resolved = resolvedModule.path;
      if (resolvedModule.format === 'esm') throw new Error(`ERR_REQUIRE_ESM: require() of ES Module ${resolved} is not supported`);
      const cached = cache.get(resolved);
      if (cached) return cached.exports;

      let source = call('module.readSource', { path: resolved }) as string;
      const module = { exports: {} as unknown };
      cache.set(resolved, module);

      try {
        if (resolved.endsWith('.json')) { module.exports = JSON.parse(source); return module.exports; }
        if (source.startsWith('#!')) {
          const newline = source.indexOf('\n');
          source = newline === -1 ? '' : source.slice(newline + 1);
        }
        const dir = dirOf(resolved);
        const fn = (0, eval)(
          '(function(exports, require, module, __filename, __dirname){' + source + '\n})'
        ) as (e: unknown, r: unknown, m: unknown, fn: string, dn: string) => void;
        fn(module.exports, makeRequire(dir), module, resolved, dir);
        return module.exports;
      } catch (error) {
        cache.delete(resolved);
        throw error;
      }
    };
    require.resolve = (request: string): string =>
      (call('module.resolve', { request, fromDir, mode: 'require' }) as { path: string }).path;
    return require;
  };

  (globalThis as Record<string, unknown>)['require'] = makeRequire('/');
  (globalThis as Record<string, unknown>)['__duskRequireFrom'] = (fromDir: string) => makeRequire(fromDir);
};
