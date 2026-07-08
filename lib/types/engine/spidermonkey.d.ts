export interface EngineSource {
    wasmUrl: string;
    args: string[];
    /**
     * Pre-compiled WebAssembly.Module ready for instantiation.
     * Computed lazily on first call and cached for the lifetime of the page.
     * Subsequent createEngine calls skip the fetch+compile (~150ms saved per spawn).
     */
    wasmModule?: WebAssembly.Module;
}
export declare const resolveSpiderMonkey: () => Promise<EngineSource>;
/**
 * Eagerly start the SpiderMonkey wasm fetch+compile so subsequent createEngine
 * calls can use the cached module immediately. Safe to call multiple times;
 * subsequent calls are no-ops.
 */
export declare const prewarmEngine: () => void;
//# sourceMappingURL=spidermonkey.d.ts.map