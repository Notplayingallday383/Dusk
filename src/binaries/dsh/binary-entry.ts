import { main } from './main';

// Reserve the exit slot so the engine entry wrapper doesn't auto-exit(0)
// while dsh's async work is still pending. See buildEntry() in
// process-manager.ts and the matching pattern in src/shell/binary-entry.ts.
type ProcRec = { _exitCode?: number; _exitReserved?: boolean; __mainPromise?: Promise<number> };
const g = globalThis as Record<string, unknown>;
if (!g.__process) g.__process = {};
const procRec = g.__process as ProcRec;
procRec._exitReserved = true;
procRec.__mainPromise = main();
procRec.__mainPromise.catch(() => { /* main errors surface via process.exit */ });
