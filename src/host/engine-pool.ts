// Engine pre-warm pool.
//
// Strategy:
//   - Maintain N pre-fetched/compiled SpiderMonkey WebAssembly.Modules in the cache.
//   - Optionally pre-spawn N "warm" Workers that have the wasm pre-compiled but
//     haven't run worldJS yet (deferred until pid is bound).
//
// For simplicity v1: only cache the compiled module. New Workers are spawned
// on demand but skip the fetch+compile step, saving ~150ms per spawn.
//
// Future v2 could add real worker pre-spawning if Worker startup cost becomes
// the bottleneck.

import { prewarmEngine } from '../engine/spidermonkey';

let prewarmStarted = false;

/**
 * Initialize the engine pool. Eagerly fetches and compiles the SpiderMonkey
 * wasm so subsequent `createEngine` calls reuse it.
 *
 * Idempotent; safe to call multiple times.
 */
export const initEnginePool = (): void => {
  if (prewarmStarted) return;
  prewarmStarted = true;
  prewarmEngine();
};

/**
 * Returns true once the wasm module has been compiled and cached.
 * Used for testing.
 */
export const isPoolWarm = async (): Promise<boolean> => {
  const { resolveSpiderMonkey } = await import('../engine/spidermonkey');
  const { wasmModule } = await resolveSpiderMonkey();
  return wasmModule !== undefined;
};
