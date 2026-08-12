// Entry point for /bin/c binary.
// Registers the main promise for the C interpreter.

import { main } from './main';

type ProcRec = { _exitCode?: number; _exitReserved?: boolean; __mainPromise?: Promise<number> };
const g = globalThis as Record<string, unknown>;
if (!g.__process) g.__process = {};
const procRec = g.__process as ProcRec;
procRec._exitReserved = true;
procRec.__mainPromise = main();
procRec.__mainPromise.catch(() => { /* main errors surface via process.exit */ });
