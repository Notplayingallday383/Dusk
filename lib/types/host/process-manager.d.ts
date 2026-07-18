import { type EngineInstance, type FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';
import { type StreamRegistry } from './stream-registry';
import { type PtyManager, type Pty } from './pty';
export interface ProcessStdinWriter {
    write(chunk: Uint8Array): Promise<void>;
    close(): Promise<void>;
}
export interface DuskProcessHandle {
    pid: number;
    exit: Promise<number>;
    stdin: ProcessStdinWriter;
    stdout: ReadableStream<Uint8Array>;
    stderr: ReadableStream<Uint8Array>;
    kill(): void;
    master?: Pty;
}
export interface SpawnOptions {
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdin?: Uint8Array | number[] | string;
    pty?: boolean | {
        cols?: number;
        rows?: number;
    };
}
export interface SpawnSyncResult {
    stdout: Uint8Array;
    stderr: Uint8Array;
    status: number;
}
export interface RelaySocket {
    onData(cb: (data: Uint8Array) => void): () => void;
    onClose(cb: (reason: number) => void): () => void;
    send(data: Uint8Array): void;
    close(reason?: number): void;
}
export interface RelayListener {
    registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void;
}
export interface ProcessManagerOptions {
    relay?: RelayListener;
}
export declare class ProcessManager {
    private fs;
    private netFuncs;
    private binaries;
    private processes;
    private nextPid;
    private socketRegistry;
    private relay;
    private relayServers;
    private relaySockets;
    private streamRegistryImpl;
    get streamRegistry(): StreamRegistry;
    private ptyManager;
    private dispatchByPid;
    private fdTables;
    private getOrCreateFDTable;
    private lazyLoaders;
    constructor(fs: FSBackend, netFuncs?: FuncTable, extraFuncs?: FuncTable, options?: ProcessManagerOptions);
    private closeRelaySocket;
    private unregisterRelayServer;
    private cleanupNetworkForPid;
    registerBinary(name: string, jsSource: string): void;
    registerLazyBinary(name: string, loader: () => Promise<string>): void;
    private maybeElideJshWrapper;
    private resolveBinary;
    getProcess(pid: number): DuskProcessHandle | undefined;
    activePids(): number[];
    listBinaries(): string[];
    hasBinary(name: string): boolean;
    getBinarySource(name: string): string | undefined;
    loadBinarySource(name: string): Promise<string | undefined>;
    getStreamRegistry(): StreamRegistry;
    getPtyManager(): PtyManager;
    getProcessRecord(pid: number): {
        pid: number;
        ppid: number;
        pgid: number;
        argv: string[];
        argv0: string;
        execPath: string;
        env: Record<string, string>;
        cwd: string;
        title: string;
        startTime: number;
    } | undefined;
    _deliverSignal(targetPid: number, signame: string): void;
    private _deliverSignalToOne;
    _deliverSignalWithPayload(targetPid: number, signame: string, payload: unknown): void;
    /**
     * Resize the PTY attached to `pid`. Fires the `onSigwinch` hook on the Pty,
     * which (when the Pty was attached via {@link spawn}) delivers `SIGWINCH`
     * with `{cols, rows}` payload to the process.
     */
    resizePty(pid: number, cols: number, rows: number): void;
    private _emitChildExit;
    createPidZero(baseFuncs: FuncTable, write: (text: string) => void, opts?: {
        user?: string;
        hostname?: string;
    }): Promise<EngineInstance>;
    spawn(cmd: string, args?: string[], options?: SpawnOptions): Promise<DuskProcessHandle>;
    spawnSync(cmd: string, args?: string[], options?: SpawnOptions): Promise<SpawnSyncResult>;
    private buildSpawnFuncs;
    private buildFuncs;
    private buildEntry;
}
//# sourceMappingURL=process-manager.d.ts.map