import type { FuncTable } from './runner';
import type { FSBackend } from './fs-backend';
declare const resolveModule: (fs: FSBackend, request: string, fromDir: string) => Promise<string>;
export declare const createFuncs: (fs: FSBackend, out: (text: string) => void) => FuncTable;
export { resolveModule };
//# sourceMappingURL=funcs.d.ts.map