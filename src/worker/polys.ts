import { Buffer } from 'buffer';

export {};

if (typeof (globalThis as { global?: unknown }).global === 'undefined') {
  (globalThis as { global?: unknown }).global = globalThis;
}

if (typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined') {
  (globalThis as { Buffer?: unknown }).Buffer = Buffer;
}

if (typeof (globalThis as { process?: unknown }).process === 'undefined') {
  (globalThis as { process?: unknown }).process = {
    env: {},
    argv: [],
    platform: 'browser',
    version: '',
    versions: {},
    nextTick: (cb: (...a: unknown[]) => void, ...args: unknown[]) => { Promise.resolve().then(() => cb(...args)); },
    cwd: () => '/',
  };
}

if (!(globalThis.Atomics as { waitAsync?: unknown }).waitAsync) {
  const helperCode = `
  onmessage = function (ev) {
      try {
          switch (ev.data[0]) {
            case 'wait': {
              let [_, ia, index, value, timeout] = ev.data;
              let result = Atomics.wait(ia, index, value, timeout);
              postMessage(['ok', result]);
              break;
            }
            default: { throw new Error('Bogus message: ' + ev.data.join(',')); }
          }
      } catch (e) { postMessage(['error', 'Exception']); }
  }`;

  const helpers: Worker[] = [];
  const allocHelper = (): Worker =>
    helpers.pop() ?? new Worker('data:application/javascript,' + encodeURIComponent(helperCode));
  const freeHelper = (h: Worker): void => { helpers.push(h); };

  const waitAsync = (ia: Int32Array, index_: number, value_: number, timeout_?: number) => {
    if (!(ia instanceof Int32Array) || !(ia.buffer instanceof SharedArrayBuffer))
      throw new TypeError('Expected shared memory');
    const index = index_ | 0;
    const value = value_ | 0;
    const timeout = timeout_ === undefined ? Infinity : +timeout_;
    void ia[index];
    if (Atomics.load(ia, index) !== value) return { async: false, value: 'not-equal' as const };
    return {
      async: true,
      value: new Promise<string>((resolve, reject) => {
        const h = allocHelper();
        h.onmessage = (ev: MessageEvent) => {
          freeHelper(h);
          if (ev.data[0] === 'ok') resolve(ev.data[1]);
          else reject(ev.data[1]);
        };
        h.postMessage(['wait', ia, index, value, timeout]);
      }),
    };
  };

  Object.defineProperty(Atomics, 'waitAsync', {
    value: waitAsync, configurable: true, enumerable: false, writable: true,
  });
}
