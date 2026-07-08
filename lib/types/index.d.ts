import { ProcessManager, type DuskProcessHandle } from './host/process-manager';
import { type LibCurl } from './host/net';
import { type DuskRepl } from './repl/repl';
import type { EngineInstance } from './host/engine-instance';
export { createRunner } from './host/runner';
export { createEngine } from './host/engine-instance';
export { ProcessManager } from './host/process-manager';
export { startRepl } from './repl/repl';
export { createMemoryBackend, createTfsBackend } from './host/fs-backend';
export { createLayoutBackend } from './host/fs-layout';
export { initEnginePool, isPoolWarm } from './host/engine-pool';
export { prewarmEngine } from './engine/spidermonkey';
export interface BootReplOptions {
    net?: {
        loadLibcurl: () => Promise<LibCurl>;
        proxyUrl: string;
    };
    seed?: Record<string, string>;
    fs?: 'tfs' | 'memory';
    user?: string;
    hostname?: string;
    layout?: boolean;
    /**
     * Routing for `feed(line)`:
     * - 'startRepl' (default): dispatch wrapped JS through the pid-0 engine via startRepl().
     * - 'node': spawn `/bin/node` (no args, no PTY) as a child; feed writes to its stdin
     *   and the child's stdout/stderr are decoded and forwarded to `write`.
     */
    via?: 'startRepl' | 'node';
    /**
     * Skip creating the pid-0 engine entirely. Saves ~100MB of RAM (a full
     * SpiderMonkey Worker) for callers that never use `feed()` and only spawn
     * child processes via `processManager.spawn(...)`. When set:
     *   - `.feed()` becomes a no-op that logs a warning
     *   - `.engine` is a lightweight stub that only implements `.terminate()`
     * Demo pages that spawn `/bin/dsh` interactively should set this.
     * Default: false (creates pid-0 for backwards compat).
     */
    skipPidZero?: boolean;
}
export interface BootReplResult extends DuskRepl {
    processManager: ProcessManager;
    /** pid-0 engine. Present unless `skipPidZero: true`, in which case it's a stub. */
    engine: EngineInstance;
    /** Present when `via: 'node'` — the spawned /bin/node child handle. */
    node?: DuskProcessHandle;
}
export declare const bootRepl: (write: (text: string) => void, options?: BootReplOptions) => Promise<BootReplResult>;
//# sourceMappingURL=index.d.ts.map