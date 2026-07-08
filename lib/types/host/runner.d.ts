import { type FuncTable } from './engine-instance';
export { createEngine, type EngineInstance, type SendFn, type FuncFn, type FuncTable } from './engine-instance';
export interface DuskRunner {
    run(js: string): Promise<void>;
    dispatch(js: string): void;
    stop(): void;
}
export declare const createRunner: (funcs?: FuncTable) => Promise<DuskRunner>;
//# sourceMappingURL=runner.d.ts.map