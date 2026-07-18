export interface RegisteredServer {
    id: number;
    host: string;
    port: number;
    enginePid: number;
    onConnection: (clientSocketId: number) => void;
}
export interface SocketPair {
    pushToClient: (chunk: Uint8Array) => void;
    closeClient: () => void;
    errorClient: (msg: string) => void;
}
export interface SocketRegistry {
    registerServer(host: string, port: number, enginePid: number, onConn: (clientSocketId: number) => void): RegisteredServer;
    unregisterServer(id: number): void;
    findServer(host: string, port: number): RegisteredServer | undefined;
    allocateSocketId(): number;
    setPair(socketId: number, pair: SocketPair): void;
    getPair(socketId: number): SocketPair | undefined;
    removePair(socketId: number): void;
}
export declare const createSocketRegistry: () => SocketRegistry;
//# sourceMappingURL=socket-registry.d.ts.map