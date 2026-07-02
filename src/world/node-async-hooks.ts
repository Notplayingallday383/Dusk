// node:async_hooks — minimal AsyncLocalStorage implementation.
// Supports sync-scope propagation via a stack maintained around run().
// Across native `await` we rely on a microtask continuation: when run()'s
// callback returns a Promise, we re-enter the same store for `.then()`
// callbacks scheduled from within that scope via a wrapping helper.
//
// This is NOT a complete async-context implementation; libraries that use
// AsyncLocalStorage with arbitrary I/O may observe context loss across some
// boundaries. It is sufficient for:
//   - sync code paths
//   - libraries that explicitly `als.run(store, () => ...)` and don't bridge
//     across raw setTimeout/microtask boundaries

const _stacks = new WeakMap<AsyncLocalStorage<unknown>, unknown[]>();
const _defaults = new WeakMap<AsyncLocalStorage<unknown>, unknown>();

export class AsyncLocalStorage<T> {
  private _enabled = true;

  disable(): void { this._enabled = false; }
  enable(): void { this._enabled = true; }

  getStore(): T | undefined {
    if (!this._enabled) return undefined;
    const stack = _stacks.get(this as AsyncLocalStorage<unknown>) as T[] | undefined;
    if (stack && stack.length > 0) return stack[stack.length - 1];
    return _defaults.get(this as AsyncLocalStorage<unknown>) as T | undefined;
  }

  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    let stack = _stacks.get(this as AsyncLocalStorage<unknown>) as T[] | undefined;
    if (!stack) {
      stack = [];
      _stacks.set(this as AsyncLocalStorage<unknown>, stack as unknown[]);
    }
    stack.push(store);
    try {
      const result = fn(...args);
      if (result !== null && typeof result === 'object' && typeof (result as { then?: unknown }).then === 'function') {
        // For async fns, keep the store alive until the promise settles.
        const localStack = stack;
        const asPromise = result as unknown as Promise<unknown>;
        return asPromise.then(
          (v: unknown) => { popIf(localStack, store); return v; },
          (e: unknown) => { popIf(localStack, store); throw e; },
        ) as unknown as R;
      }
      stack.pop();
      return result;
    } catch (e) {
      stack.pop();
      throw e;
    }
  }

  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const stack = _stacks.get(this as AsyncLocalStorage<unknown>) as T[] | undefined;
    if (!stack || stack.length === 0) return fn(...args);
    const saved = stack.slice();
    stack.length = 0;
    try { return fn(...args); }
    finally { for (const v of saved) stack.push(v); }
  }

  enterWith(store: T): void {
    let stack = _stacks.get(this as AsyncLocalStorage<unknown>) as T[] | undefined;
    if (!stack) {
      stack = [];
      _stacks.set(this as AsyncLocalStorage<unknown>, stack as unknown[]);
    }
    stack.push(store);
  }

  static bind<F extends Function>(fn: F): F {
    return fn;
  }

  static snapshot(): <R>(fn: () => R) => R {
    return <R>(fn: () => R): R => fn();
  }
}

const popIf = <T>(stack: T[], store: T): void => {
  const idx = stack.lastIndexOf(store);
  if (idx >= 0) stack.splice(idx, 1);
};

// AsyncResource — minimal no-op
export class AsyncResource {
  readonly type: string;
  constructor(type: string, _opts?: unknown) {
    this.type = type;
  }
  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return fn.apply(thisArg, args);
  }
  emitDestroy(): this { return this; }
  asyncId(): number { return 0; }
  triggerAsyncId(): number { return 0; }
  static bind<F extends Function>(fn: F, _type?: string, _thisArg?: unknown): F {
    return fn;
  }
}

// async_hooks main surface (mostly no-op stubs)

let asyncIdCounter = 1;

export const executionAsyncId = (): number => 0;
export const triggerAsyncId = (): number => 0;
export const executionAsyncResource = (): unknown => ({});

export const createHook = (_callbacks: Record<string, Function | undefined>): {
  enable(): unknown; disable(): unknown;
} => {
  return {
    enable(): unknown { return this; },
    disable(): unknown { return this; },
  };
};

export const asyncWrapProviders = Object.freeze({});

export const nextAsyncId = (): number => asyncIdCounter++;

export const nodeAsyncHooks = {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId,
  triggerAsyncId,
  executionAsyncResource,
  createHook,
  asyncWrapProviders,
};
