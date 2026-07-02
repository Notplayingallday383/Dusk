// Host-side stream registry for credit-based IPC streaming.
//
// v2: byte-window credit accounting.
//
// Each allocated stream is seeded with STREAM_INITIAL_WINDOW bytes of credit.
// pushChunk debits credit by the chunk's byteLength; grantCredit re-adds it.
// Optional onLow/onResume callbacks let the producer pause/resume its source
// ReadableStream when the window drains and later refills.

export type StreamId = number;

export const STREAM_INITIAL_WINDOW = 64 * 1024;

export interface StreamRegistration {
  id: StreamId;
  producerPid: number;
  consumerPid: number;
  onChunk: (chunk: Uint8Array) => void;
  onEnd: () => void;
  onError: (msg: string) => void;
  // Optional flow-control callbacks. Producer subscribes to these.
  onLow?: () => void;     // credit just hit 0 (or below)
  onResume?: () => void;  // credit just crossed back above 0
  // Optional consumer-close hook. Invoked by closeFromConsumer(id) so the
  // producer's side (typically ProcessManager) can deliver SIGPIPE.
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

export const createStreamRegistry = (): StreamRegistry => {
  let nextId = 1;
  const streams = new Map<StreamId, StreamRegistration>();
  const credits = new Map<StreamId, number>();

  const debit = (id: StreamId, n: number): void => {
    const reg = streams.get(id);
    const prev = credits.get(id) ?? 0;
    const next = prev - n;
    credits.set(id, next);
    if (reg && prev > 0 && next <= 0) {
      try { reg.onLow?.(); } catch { /* */ }
    }
  };

  return {
    allocate(): StreamId {
      const id = nextId++;
      credits.set(id, STREAM_INITIAL_WINDOW);
      return id;
    },
    register(reg: StreamRegistration): void {
      streams.set(reg.id, reg);
    },
    get(id: StreamId): StreamRegistration | undefined {
      return streams.get(id);
    },
    pushChunk(id: StreamId, chunk: Uint8Array): void {
      const reg = streams.get(id);
      if (!reg) return;
      try { reg.onChunk(chunk); } catch { /* */ }
      debit(id, chunk.byteLength);
    },
    pushEnd(id: StreamId): void {
      const reg = streams.get(id);
      if (!reg) return;
      try { reg.onEnd(); } catch { /* */ }
      streams.delete(id);
      credits.delete(id);
    },
    pushError(id: StreamId, msg: string): void {
      const reg = streams.get(id);
      if (!reg) return;
      try { reg.onError(msg); } catch { /* */ }
      streams.delete(id);
      credits.delete(id);
    },
    close(id: StreamId): void {
      streams.delete(id);
      credits.delete(id);
    },
    closeFromConsumer(id: StreamId): void {
      const reg = streams.get(id);
      if (!reg) return;
      try { reg.onConsumerClose?.() } catch { /* */ }
      streams.delete(id);
      credits.delete(id);
    },
    grantCredit(id: StreamId, amount: number): void {
      const reg = streams.get(id);
      const prev = credits.get(id) ?? 0;
      const next = prev + amount;
      credits.set(id, next);
      if (reg && prev <= 0 && next > 0) {
        try { reg.onResume?.(); } catch { /* */ }
      }
    },
    availableCredit(id: StreamId): number {
      return credits.get(id) ?? 0;
    },
  };
};
