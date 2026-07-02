import { main } from './index';

// Reserve the exit slot so the engine entry wrapper doesn't auto-exit(0)
// while our interactive stdin loop is awaiting input. When _exitReserved is
// true, the wrapper awaits __mainPromise instead of assuming completion.
// See buildEntry() in process-manager.ts.
type ProcRec = { _exitCode?: number; _exitReserved?: boolean; __mainPromise?: Promise<number> };
const g = globalThis as Record<string, unknown>;
if (!g.__process) g.__process = {};
const procRec = g.__process as ProcRec;
procRec._exitReserved = true;
procRec.__mainPromise = main();
procRec.__mainPromise.catch(() => { /* main errors surface via process.exit */ });
