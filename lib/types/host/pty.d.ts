export interface PtyOptions {
    cols?: number;
    rows?: number;
}
export interface PtyHooks {
    onSlaveStdin?: (bytes: Uint8Array) => void;
    onSignal?: (sig: string) => void;
    onSigwinch?: (cols: number, rows: number) => void;
}
export interface Pty {
    pid: number;
    cols: number;
    rows: number;
    rawMode: boolean;
    masterWrite(bytes: Uint8Array): void;
    onMasterData(cb: (bytes: Uint8Array) => void): void;
    slaveWrite(bytes: Uint8Array): void;
    resize(cols: number, rows: number): void;
    setRawMode(raw: boolean): void;
    close(): void;
}
export declare const createPty: (pid: number, opts?: PtyOptions, hooks?: PtyHooks) => Pty;
export interface PtyManager {
    attach(pid: number, opts?: PtyOptions, hooks?: PtyHooks): Pty;
    get(pid: number): Pty | undefined;
    detach(pid: number): void;
    resize(pid: number, cols: number, rows: number): void;
}
export declare const createPtyManager: () => PtyManager;
//# sourceMappingURL=pty.d.ts.map