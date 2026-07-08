import type { FuncTable } from './runner';
export interface NetHost {
    funcs: FuncTable;
    registerLibcurl(name: string, instance: LibCurl): void;
    registerTransport(name: string, transport: unknown): void;
}
export interface LibCurl {
    load_wasm(url?: string): Promise<void>;
    set_websocket(url: string): void;
    fetch(url: string, opts?: unknown): Promise<Response>;
    WebSocket: new (url: string, protocols?: string[]) => WebSocket;
    transport?: unknown;
    version?: unknown;
    HTTPSession?: new (opts?: unknown) => {
        fetch(url: string, opts?: unknown): Promise<Response>;
        close(): void;
    };
    TLSSocket?: new (host: string, port: number, opts?: unknown) => {
        onopen: (() => void) | null;
        onmessage: ((d: Uint8Array) => void) | null;
        onclose: (() => void) | null;
        onerror: ((e: unknown) => void) | null;
        send(data: Uint8Array): void;
        close(): void;
    };
}
export declare const createNet: (loadLibcurl: () => Promise<LibCurl>, dispatch: (js: string) => void, proxyUrl: string) => NetHost;
//# sourceMappingURL=net.d.ts.map