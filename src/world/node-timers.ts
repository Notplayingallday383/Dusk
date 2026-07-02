// node:timers — thin wrapper around globals.
// node:timers/promises lives at the bottom.

type STFn = (handler: Function, timeout?: number, ...args: unknown[]) => unknown;
type CTFn = (id: unknown) => void;

const _setTimeout: STFn = ((globalThis as { setTimeout?: STFn }).setTimeout ?? ((fn: Function) => { fn(); return 0; })) as STFn;
const _setInterval: STFn = ((globalThis as { setInterval?: STFn }).setInterval ?? (() => 0)) as STFn;
const _clearTimeout: CTFn = ((globalThis as { clearTimeout?: CTFn }).clearTimeout ?? (() => undefined)) as CTFn;
const _clearInterval: CTFn = ((globalThis as { clearInterval?: CTFn }).clearInterval ?? (() => undefined)) as CTFn;

export { _setTimeout as setTimeout, _setInterval as setInterval, _clearTimeout as clearTimeout, _clearInterval as clearInterval };

// setImmediate / clearImmediate fallback (queueMicrotask)
const _setImmediate = (fn: Function, ...args: unknown[]): unknown => {
  const si = (globalThis as { setImmediate?: Function }).setImmediate;
  if (typeof si === 'function') {
    return si(fn, ...args);
  }
  return _setTimeout(() => (fn as Function)(...args), 0);
};

const _clearImmediate = (id: unknown): void => {
  const ci = (globalThis as { clearImmediate?: Function }).clearImmediate;
  if (typeof ci === 'function') {
    ci(id);
    return;
  }
  _clearTimeout(id);
};

export { _setImmediate as setImmediate, _clearImmediate as clearImmediate };

export const nodeTimers = {
  setTimeout: _setTimeout,
  setInterval: _setInterval,
  clearTimeout: _clearTimeout,
  clearInterval: _clearInterval,
  setImmediate: _setImmediate,
  clearImmediate: _clearImmediate,
};

// node:timers/promises
const promisesSetTimeout = (ms: number, value?: unknown, _opts?: { signal?: AbortSignal; ref?: boolean }): Promise<unknown> => {
  return new Promise((resolve) => {
    _setTimeout(() => resolve(value), ms);
  });
};

const promisesSetImmediate = (value?: unknown): Promise<unknown> => {
  return new Promise((resolve) => {
    _setImmediate(() => resolve(value));
  });
};

const promisesSetInterval = async function* (ms: number, value?: unknown): AsyncGenerator<unknown> {
  while (true) {
    yield new Promise((r) => _setTimeout(() => r(value), ms));
  }
};

export const nodeTimersPromises = {
  setTimeout: promisesSetTimeout,
  setImmediate: promisesSetImmediate,
  setInterval: promisesSetInterval,
};
