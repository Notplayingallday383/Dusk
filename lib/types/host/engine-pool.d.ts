/**
 * Initialize the engine pool. Eagerly fetches and compiles the SpiderMonkey
 * wasm so subsequent `createEngine` calls reuse it.
 *
 * Idempotent; safe to call multiple times.
 */
export declare const initEnginePool: () => void;
/**
 * Returns true once the wasm module has been compiled and cached.
 * Used for testing.
 */
export declare const isPoolWarm: () => Promise<boolean>;
//# sourceMappingURL=engine-pool.d.ts.map