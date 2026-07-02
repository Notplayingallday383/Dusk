type Listener = (...args: unknown[]) => void;

interface InternalListener {
  fn: Listener;
  once: boolean;
}

const kCapture = Symbol('captureRejections');

interface EmitterState {
  events: Map<string | symbol, InternalListener[]>;
  maxListeners: number;
  captureRejections: boolean;
}

const isFn = (v: unknown): v is Listener => typeof v === 'function';

const ensureFn = (v: unknown, name: string): Listener => {
  if (!isFn(v)) {
    const err = new TypeError(`The "${name}" argument must be of type function. Received ${typeof v}`);
    (err as unknown as Record<string, unknown>)['code'] = 'ERR_INVALID_ARG_TYPE';
    throw err;
  }
  return v;
};

let defaultMaxListeners = 10;

export class EventEmitter {
  private _state: EmitterState;
  static defaultMaxListeners = 10;
  static readonly captureRejectionSymbol = kCapture;
  static readonly errorMonitor = Symbol('events.errorMonitor');

  constructor(opts?: { captureRejections?: boolean }) {
    this._state = {
      events: new Map(),
      maxListeners: defaultMaxListeners,
      captureRejections: opts?.captureRejections ?? false,
    };
  }

  setMaxListeners(n: number): this {
    if (typeof n !== 'number' || n < 0 || Number.isNaN(n)) {
      const err = new RangeError(`The value of "n" is out of range. It must be a non-negative number. Received ${n}`);
      (err as unknown as Record<string, unknown>)['code'] = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    this._state.maxListeners = n;
    return this;
  }

  getMaxListeners(): number {
    return this._state.maxListeners;
  }

  emit(event: string | symbol, ...args: unknown[]): boolean {
    const listeners = this._state.events.get(event);
    if (event === 'error') {
      const errMonitorListeners = this._state.events.get(EventEmitter.errorMonitor);
      if (errMonitorListeners) {
        for (const l of errMonitorListeners.slice()) {
          try { l.fn.apply(this, args); } catch { /* */ }
        }
      }
    }
    if (!listeners || listeners.length === 0) {
      if (event === 'error') {
        const err = args[0];
        if (err instanceof Error) throw err;
        const wrapped = new Error('Unhandled error.');
        (wrapped as unknown as Record<string, unknown>)['context'] = err;
        throw wrapped;
      }
      return false;
    }
    const snapshot = listeners.slice();
    for (const l of snapshot) {
      if (l.once) this._removeOne(event, l);
      try {
        const r = l.fn.apply(this, args);
        if (this._state.captureRejections && r && typeof (r as Promise<unknown>).then === 'function') {
          (r as Promise<unknown>).then(undefined, (err: unknown) => {
            if (event === 'error') {
              try { this.emit('error', err); } catch { /* */ }
            } else {
              try { this.emit('error', err); } catch { /* */ }
            }
          });
        }
      } catch (err) {
        if (event === 'error') throw err;
        try { this.emit('error', err); } catch { throw err; }
      }
    }
    return true;
  }

  addListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false, false);
  }
  on(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false, false);
  }
  prependListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, false, true);
  }
  once(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, true, false);
  }
  prependOnceListener(event: string | symbol, listener: Listener): this {
    return this._add(event, listener, true, true);
  }

  private _add(event: string | symbol, listener: unknown, once: boolean, prepend: boolean): this {
    const fn = ensureFn(listener, 'listener');
    let arr = this._state.events.get(event);
    if (!arr) {
      arr = [];
      this._state.events.set(event, arr);
    }
    this.emit('newListener', event, fn);
    const wrapped: InternalListener = { fn, once };
    if (prepend) arr.unshift(wrapped);
    else arr.push(wrapped);
    if (this._state.maxListeners > 0 && arr.length > this._state.maxListeners) {
      // best-effort warning via console
      const g = globalThis as Record<string, unknown>;
      const c = g['console'] as { error?: (...a: unknown[]) => void } | undefined;
      if (c && c.error) c.error(`MaxListenersExceededWarning: Possible EventEmitter memory leak detected. ${arr.length} ${String(event)} listeners added.`);
    }
    return this;
  }

  removeListener(event: string | symbol, listener: Listener): this {
    ensureFn(listener, 'listener');
    const arr = this._state.events.get(event);
    if (!arr) return this;
    for (let i = arr.length - 1; i >= 0; i--) {
      const cur = arr[i];
      if (cur && cur.fn === listener) {
        arr.splice(i, 1);
        this.emit('removeListener', event, listener);
        break;
      }
    }
    if (arr.length === 0) this._state.events.delete(event);
    return this;
  }
  off(event: string | symbol, listener: Listener): this {
    return this.removeListener(event, listener);
  }

  private _removeOne(event: string | symbol, target: InternalListener): void {
    const arr = this._state.events.get(event);
    if (!arr) return;
    const idx = arr.indexOf(target);
    if (idx >= 0) arr.splice(idx, 1);
    if (arr.length === 0) this._state.events.delete(event);
  }

  removeAllListeners(event?: string | symbol): this {
    if (event === undefined) {
      this._state.events.clear();
      return this;
    }
    this._state.events.delete(event);
    return this;
  }

  listeners(event: string | symbol): Listener[] {
    const arr = this._state.events.get(event);
    if (!arr) return [];
    return arr.map((l) => l.fn);
  }

  rawListeners(event: string | symbol): Listener[] {
    return this.listeners(event);
  }

  listenerCount(event: string | symbol): number {
    return this._state.events.get(event)?.length ?? 0;
  }

  eventNames(): (string | symbol)[] {
    return [...this._state.events.keys()];
  }
}

Object.defineProperty(EventEmitter, 'defaultMaxListeners', {
  get: () => defaultMaxListeners,
  set: (v: number) => {
    if (typeof v !== 'number' || v < 0 || Number.isNaN(v)) {
      const err = new RangeError(`defaultMaxListeners must be a non-negative number`);
      (err as unknown as Record<string, unknown>)['code'] = 'ERR_OUT_OF_RANGE';
      throw err;
    }
    defaultMaxListeners = v;
  },
  configurable: true,
});

export const once = (
  emitter: { on(e: string, l: Listener): unknown; off(e: string, l: Listener): unknown },
  event: string,
): Promise<unknown[]> => {
  return new Promise<unknown[]>((resolve, reject) => {
    const ok = (...args: unknown[]): void => {
      emitter.off('error', err);
      resolve(args);
    };
    const err = (e: unknown): void => {
      emitter.off(event, ok);
      reject(e);
    };
    emitter.on(event, ok);
    emitter.on('error', err);
  });
};

export const on = (
  emitter: { on(e: string, l: Listener): unknown; off(e: string, l: Listener): unknown },
  event: string,
): AsyncIterable<unknown[]> => {
  const buffer: unknown[][] = [];
  const waiters: Array<{ resolve: (v: IteratorResult<unknown[]>) => void; reject: (e: unknown) => void }> = [];
  let done = false;
  let error: unknown = null;

  const push = (...args: unknown[]): void => {
    if (waiters.length > 0) {
      const w = waiters.shift()!;
      w.resolve({ value: args, done: false });
    } else {
      buffer.push(args);
    }
  };
  const fail = (e: unknown): void => {
    error = e;
    done = true;
    while (waiters.length) waiters.shift()!.reject(e);
  };
  emitter.on(event, push);
  emitter.on('error', fail);

  return {
    [Symbol.asyncIterator](): AsyncIterator<unknown[]> {
      return {
        next(): Promise<IteratorResult<unknown[]>> {
          if (buffer.length > 0) {
            return Promise.resolve({ value: buffer.shift()!, done: false });
          }
          if (done) {
            if (error) return Promise.reject(error);
            return Promise.resolve({ value: undefined as unknown as unknown[], done: true });
          }
          return new Promise<IteratorResult<unknown[]>>((resolve, reject) => {
            waiters.push({ resolve, reject });
          });
        },
        return(): Promise<IteratorResult<unknown[]>> {
          done = true;
          emitter.off(event, push);
          emitter.off('error', fail);
          return Promise.resolve({ value: undefined as unknown as unknown[], done: true });
        },
      };
    },
  };
};

export const setMaxListeners = (n: number, ...emitters: EventEmitter[]): void => {
  if (emitters.length === 0) {
    defaultMaxListeners = n;
    return;
  }
  for (const e of emitters) e.setMaxListeners(n);
};

export const getEventListeners = (
  emitter: EventEmitter | EventTarget,
  event: string | symbol,
): Listener[] => {
  if (emitter instanceof EventEmitter) return emitter.listeners(event);
  return [];
};

export const nodeEvents = {
  EventEmitter,
  default: EventEmitter,
  once,
  on,
  setMaxListeners,
  getEventListeners,
  captureRejectionSymbol: EventEmitter.captureRejectionSymbol,
  errorMonitor: EventEmitter.errorMonitor,
  get defaultMaxListeners(): number { return defaultMaxListeners; },
  set defaultMaxListeners(v: number) {
    if (typeof v !== 'number' || v < 0 || Number.isNaN(v)) {
      throw new RangeError('defaultMaxListeners must be a non-negative number');
    }
    defaultMaxListeners = v;
  },
};
