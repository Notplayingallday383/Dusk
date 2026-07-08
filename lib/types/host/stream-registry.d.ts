export type StreamId = number;
export declare const STREAM_INITIAL_WINDOW: number;
export interface StreamRegistration {
    id: StreamId;
    producerPid: number;
    consumerPid: number;
    onChunk: (chunk: Uint8Array) => void;
    onEnd: () => void;
    onError: (msg: string) => void;
    onLow?: () => void;
    onResume?: () => void;
    onConsumerClose?: () => void;
}
export interface StreamRegistry {
    allocate(): StreamId;
    register(reg: StreamRegistration): void;
    get(id: StreamId): StreamRegistration | undefined;
    pushChunk(id: StreamId, chunk: Uint8Array): void;
    pushEnd(id: StreamId): void;
    pushError(id: StreamId, msg: string): void;
    close(id: StreamId): void;
    closeFromConsumer(id: StreamId): void;
    grantCredit(id: StreamId, amount: number): void;
    availableCredit(id: StreamId): number;
}
export declare const createStreamRegistry: () => StreamRegistry;
//# sourceMappingURL=stream-registry.d.ts.map