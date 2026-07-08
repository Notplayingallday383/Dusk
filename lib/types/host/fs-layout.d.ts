import type { FSBackend } from './fs-backend';
import type { ProcessManager } from './process-manager';
export interface LayoutOptions {
    ephemeral: FSBackend;
    persistent: FSBackend;
    processManager: ProcessManager;
    user: string;
    hostname: string;
}
export declare const createLayoutBackend: (opts: LayoutOptions) => Promise<FSBackend>;
//# sourceMappingURL=fs-layout.d.ts.map