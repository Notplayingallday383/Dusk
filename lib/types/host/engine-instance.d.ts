export type SendFn = (msg: unknown) => void;
export type FuncFn = (msg: Record<string, unknown>, send: SendFn) => void;
export type FuncTable = Record<string, FuncFn>;
export interface EngineInstance {
    pid: number;
    run(js: string): Promise<void>;
    dispatch(js: string): void;
    terminate(): Promise<number>;
    readonly exited: Promise<number>;
}
export declare const createEngine: (pid: number, funcs?: FuncTable) => Promise<EngineInstance>;
//# sourceMappingURL=engine-instance.d.ts.map