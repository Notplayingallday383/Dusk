export interface FSCaller {
    pid: number;
}
export interface FSStat {
    isFile: boolean;
    isDirectory: boolean;
}
export interface FSReadResult {
    bytes: Uint8Array;
    bytesRead: number;
}
export interface FSWriteResult {
    bytesWritten: number;
}
export interface FSFstat {
    isFile: boolean;
    isDirectory: boolean;
    size: number;
}
export declare const O_RDONLY = 0;
export declare const O_WRONLY = 1;
export declare const O_RDWR = 2;
export declare const O_CREAT = 64;
export declare const O_EXCL = 128;
export declare const O_TRUNC = 512;
export declare const O_APPEND = 1024;
export interface FSBackend {
    readFile(path: string, caller?: FSCaller): Promise<string>;
    writeFile(path: string, data: string, caller?: FSCaller): Promise<void>;
    readFileBytes(path: string, caller?: FSCaller): Promise<Uint8Array>;
    writeFileBytes(path: string, data: Uint8Array, caller?: FSCaller): Promise<void>;
    readdir(path: string, caller?: FSCaller): Promise<string[]>;
    mkdir(path: string, opts?: {
        recursive?: boolean;
    }, caller?: FSCaller): Promise<void>;
    rm(path: string, opts?: {
        recursive?: boolean;
    }, caller?: FSCaller): Promise<void>;
    exists(path: string, caller?: FSCaller): Promise<boolean>;
    stat(path: string, caller?: FSCaller): Promise<FSStat>;
    rename(from: string, to: string, caller?: FSCaller): Promise<void>;
    openHandle(path: string, flags: number, caller?: FSCaller): Promise<{
        handle: number;
        size: number;
        appendOnly: boolean;
    }>;
    readHandle(handle: number, length: number, position: number, caller?: FSCaller): Promise<FSReadResult>;
    writeHandle(handle: number, data: Uint8Array, position: number, caller?: FSCaller): Promise<FSWriteResult>;
    closeHandle(handle: number, caller?: FSCaller): Promise<void>;
    fstatHandle(handle: number, caller?: FSCaller): Promise<FSFstat>;
    ftruncateHandle(handle: number, length: number, caller?: FSCaller): Promise<void>;
    fsyncHandle(handle: number, caller?: FSCaller): Promise<void>;
    symlink?(target: string, path: string, caller?: FSCaller): Promise<void>;
    readlink?(path: string, caller?: FSCaller): Promise<string>;
    lstat?(path: string, caller?: FSCaller): Promise<FSStat & {
        isSymlink?: boolean;
    }>;
}
export declare const createMemoryBackend: () => FSBackend;
export declare const createTfsBackend: () => Promise<FSBackend>;
//# sourceMappingURL=fs-backend.d.ts.map