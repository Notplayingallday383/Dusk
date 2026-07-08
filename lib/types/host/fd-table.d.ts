export interface FDEntry {
    backendHandle: number;
    path: string;
    flags: number;
    position: number;
    appendOnly: boolean;
}
export interface FDTable {
    allocate(init: Omit<FDEntry, 'position'> & {
        position?: number;
    }): number;
    release(fd: number): FDEntry | undefined;
    get(fd: number): FDEntry | undefined;
    closeAll(visit: (entry: FDEntry, fd: number) => void): void;
    size(): number;
}
export declare const createFDTable: (maxOpen?: number) => FDTable;
//# sourceMappingURL=fd-table.d.ts.map