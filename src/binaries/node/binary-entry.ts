// /bin/node — DuskJS Node.js launcher binary.
//
// Usage:
//   node script.js           — run a script file (CJS or ESM auto-detected)
//   node -e <expr>           — evaluate inline expression
//   node -p <expr>           — evaluate and print result
//   node --version           — print Node version
//
// CJS scripts are wrapped in a function with (exports, require, module, __filename, __dirname).
// ESM scripts (.mjs, or .js with adjacent package.json "type":"module") go through __import__.

import { main } from './main';

type ProcRec = { _exitCode?: number; _exitReserved?: boolean; __mainPromise?: Promise<number> };
const g = globalThis as Record<string, unknown>;
if (!g.__process) g.__process = {};
const procRec = g.__process as ProcRec;
procRec._exitReserved = true;
procRec.__mainPromise = main().then((code) => code ?? 0);
procRec.__mainPromise.catch(() => { /* main errors surface via process.exit */ });
