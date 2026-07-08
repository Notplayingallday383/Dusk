export interface VFS {
    readFile(path: string): string;
    writeFile(path: string, data: string): void;
    readFileBytes(path: string): Uint8Array;
    writeFileBytes(path: string, data: Uint8Array): void;
    fileSize(path: string): number;
    readdir(path: string): string[];
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }): void;
    rm(path: string): void;
    exists(path: string): boolean;
    stat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
    };
    rename(from: string, to: string): void;
    symlink(target: string, path: string): void;
    readlink(path: string): string;
    lstat(path: string): {
        isFile: boolean;
        isDirectory: boolean;
        isSymlink: boolean;
    };
}
declare const norm: (p: string) => string;
declare const dirname: (p: string) => string;
declare const basename: (p: string) => string;
declare const encodeUtf8: (s: string) => Uint8Array;
declare const decodeUtf8: (bytes: Uint8Array) => string;
export declare const createVFS: () => VFS;
export { norm, dirname, basename, encodeUtf8, decodeUtf8 };
//# sourceMappingURL=vfs.d.ts.map