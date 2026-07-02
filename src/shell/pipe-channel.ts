export interface PipeChannel {
  write(chunk: Uint8Array): Promise<void>;
  close(): void;          // writer side EOF
  closeReader(): void;    // reader side gone -> EPIPE to producers
  readable: AsyncIterable<Uint8Array>;
  isClosed(): boolean;    // reader closed
}

interface PendingWrite {
  chunk: Uint8Array;
  resolve: () => void;
  reject: (e: Error) => void;
}

interface PendingRead {
  resolve: (r: IteratorResult<Uint8Array>) => void;
}

export const createPipeChannel = (capacityChunks: number): PipeChannel => {
  if (capacityChunks < 1) throw new Error('capacity must be >= 1');
  const queue: Uint8Array[] = [];
  const pendingWrites: PendingWrite[] = [];
  const pendingReads: PendingRead[] = [];
  let writerClosed = false;
  let readerClosed = false;

  const epipe = (): Error => {
    const e = new Error('EPIPE: reader closed') as Error & { code: string };
    e.code = 'EPIPE';
    return e;
  };

  const tryDeliver = (): void => {
    while (pendingReads.length > 0 && queue.length > 0) {
      const r = pendingReads.shift()!;
      const chunk = queue.shift()!;
      r.resolve({ value: chunk, done: false });
      // Each delivery frees one slot — wake one pending writer
      if (pendingWrites.length > 0) {
        const w = pendingWrites.shift()!;
        queue.push(w.chunk);
        w.resolve();
      }
    }
    if (pendingReads.length > 0 && queue.length === 0 && writerClosed) {
      while (pendingReads.length > 0) {
        pendingReads.shift()!.resolve({ value: undefined as unknown as Uint8Array, done: true });
      }
    }
  };

  const write = (chunk: Uint8Array): Promise<void> => {
    if (readerClosed) return Promise.reject(epipe());
    if (writerClosed) return Promise.reject(new Error('write after close'));
    if (queue.length < capacityChunks) {
      queue.push(chunk);
      tryDeliver();
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      pendingWrites.push({ chunk, resolve, reject });
    });
  };

  const close = (): void => {
    writerClosed = true;
    tryDeliver();
    // If reader is still around but writer is done, resolve any pending reads with done.
    while (pendingReads.length > 0 && queue.length === 0) {
      pendingReads.shift()!.resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
  };

  const closeReader = (): void => {
    if (readerClosed) return;
    readerClosed = true;
    queue.length = 0;
    while (pendingWrites.length > 0) {
      pendingWrites.shift()!.reject(epipe());
    }
    while (pendingReads.length > 0) {
      pendingReads.shift()!.resolve({ value: undefined as unknown as Uint8Array, done: true });
    }
  };

  const readable: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
      return {
        next: (): Promise<IteratorResult<Uint8Array>> => {
          if (readerClosed) return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
          if (queue.length > 0) {
            const chunk = queue.shift()!;
            if (pendingWrites.length > 0) {
              const w = pendingWrites.shift()!;
              queue.push(w.chunk);
              w.resolve();
            }
            return Promise.resolve({ value: chunk, done: false });
          }
          if (writerClosed) return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
          return new Promise((resolve) => { pendingReads.push({ resolve }); });
        },
        return: (): Promise<IteratorResult<Uint8Array>> => {
          closeReader();
          return Promise.resolve({ value: undefined as unknown as Uint8Array, done: true });
        },
      };
    },
  };

  return { write, close, closeReader, readable, isClosed: () => readerClosed };
};
