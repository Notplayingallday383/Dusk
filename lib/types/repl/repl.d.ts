export interface DuskRepl {
    feed(line: string): Promise<void>;
}
export interface ReplEngine {
    run(js: string): Promise<void>;
}
export declare const startRepl: (runner: ReplEngine, write: (text: string) => void) => DuskRepl;
//# sourceMappingURL=repl.d.ts.map