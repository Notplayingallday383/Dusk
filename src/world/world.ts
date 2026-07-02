// DuskJS in-engine world (runs inside js.wasm). No DOM. Loaded as raw text.
import { installNodeGlobals } from './node-globals';
import { installRequire } from './require';
import { installESM } from './esm';
import { installNet } from './net';

// Timer polyfills for the SpiderMonkey shell. The shell provides a synchronous
// `setTimeout` (fires during drainJobQueue with no real delay) but nothing
// else in the timer family. Third-party libraries (just-bash, sprintf-js
// chains, Node stdlib re-exports) assume the full pair exists — undefined
// `clearTimeout` in particular crashes anything that stores a handle for
// later cancellation. Install no-op fallbacks BEFORE any engine module
// installs its own wrappers.
{
  const g = globalThis as Record<string, unknown>;
  if (typeof g['clearTimeout'] === 'undefined') {
    g['clearTimeout'] = (_id?: unknown): void => { /* no-op — fake setTimeout is synchronous */ };
  }
  if (typeof g['clearInterval'] === 'undefined') {
    g['clearInterval'] = (_id?: unknown): void => { /* no-op */ };
  }
  if (typeof g['setInterval'] === 'undefined') {
    // Fire once synchronously (matches the fake setTimeout semantics) and
    // return a nominal handle so clearInterval(id) is symmetric.
    g['setInterval'] = (fn: () => void, _ms?: number): number => {
      try { fn(); } catch { /* */ }
      return 0;
    };
  }
  if (typeof g['setImmediate'] === 'undefined') {
    g['setImmediate'] = (fn: () => void, ...args: unknown[]): number => {
      Promise.resolve().then(() => { try { (fn as (...a: unknown[]) => void)(...args); } catch { /* */ } });
      return 0;
    };
  }
  if (typeof g['clearImmediate'] === 'undefined') {
    g['clearImmediate'] = (_id?: unknown): void => { /* no-op */ };
  }
  if (typeof g['queueMicrotask'] === 'undefined') {
    g['queueMicrotask'] = (fn: () => void): void => {
      Promise.resolve().then(fn).catch(() => { /* */ });
    };
  }
}

// TextEncoder / TextDecoder polyfills — third-party code (just-bash, most
// npm libraries) assumes these exist. SpiderMonkey shell doesn't ship them.
// Minimal spec-close implementations: UTF-8 only, no BOM handling, no
// stream state on decode(). Sufficient for library interop.
{
  const g = globalThis as Record<string, unknown>;
  if (typeof g['TextEncoder'] === 'undefined') {
    class PolyTextEncoder {
      readonly encoding = 'utf-8';
      encode(input: string = ''): Uint8Array {
        const bytes: number[] = [];
        for (let i = 0; i < input.length; i++) {
          let c = input.charCodeAt(i);
          // Handle surrogate pairs
          if (c >= 0xd800 && c <= 0xdbff && i + 1 < input.length) {
            const low = input.charCodeAt(i + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
              c = 0x10000 + ((c - 0xd800) << 10) + (low - 0xdc00);
              i++;
            }
          }
          if (c < 0x80) {
            bytes.push(c);
          } else if (c < 0x800) {
            bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
          } else if (c < 0x10000) {
            bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
          } else {
            bytes.push(
              0xf0 | (c >> 18),
              0x80 | ((c >> 12) & 0x3f),
              0x80 | ((c >> 6) & 0x3f),
              0x80 | (c & 0x3f),
            );
          }
        }
        return new Uint8Array(bytes);
      }
      encodeInto(source: string, dest: Uint8Array): { read: number; written: number } {
        const encoded = this.encode(source);
        const written = Math.min(encoded.length, dest.length);
        for (let i = 0; i < written; i++) dest[i] = encoded[i]!;
        return { read: source.length, written };
      }
    }
    g['TextEncoder'] = PolyTextEncoder;
  }
  // Minimal `globalThis.crypto` shim so third-party libs (just-bash's
  // sha256sum, uuid packages, etc.) can call the standard WebCrypto API.
  // Routes through the host's crypto.digest / crypto.random funcs.
  const gc = g['crypto'] as Record<string, unknown> | undefined;
  if (!gc || typeof (gc['subtle'] as Record<string, unknown> | undefined)?.['digest'] !== 'function') {
    const cryptoCall = (fname: string, extra: Record<string, unknown>): unknown => {
      const ipc2 = (globalThis as { ipc?: { send: (m: unknown) => { value?: unknown; error?: string } } }).ipc;
      if (!ipc2) throw new Error('crypto: ipc not available');
      const r = ipc2.send({ f: fname, ...extra });
      if (r.error) throw new Error(r.error);
      return r.value;
    };
    const bytesFrom = (input: unknown): Uint8Array => {
      if (input instanceof Uint8Array) return input;
      if (input instanceof ArrayBuffer) return new Uint8Array(input);
      if (ArrayBuffer.isView(input as ArrayBufferView)) {
        const v = input as ArrayBufferView;
        return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      }
      throw new TypeError('crypto: expected BufferSource');
    };
    const subtle = {
      async digest(algorithm: string | { name: string }, data: BufferSource): Promise<ArrayBuffer> {
        const algo = typeof algorithm === 'string' ? algorithm : algorithm.name;
        const bytes = bytesFrom(data);
        const result = cryptoCall('crypto.digest', {
          algorithm: algo,
          data: Array.from(bytes),
        }) as number[];
        return Uint8Array.from(result).buffer;
      },
      async importKey(_format: string, keyData: BufferSource, algo: { name: string; hash?: string | { name: string } }, extractable: boolean, usages: string[]): Promise<unknown> {
        return { _raw: bytesFrom(keyData), algo, extractable, usages };
      },
      async sign(algorithm: string | { name: string }, key: { _raw: Uint8Array; algo: { hash?: string | { name: string } } }, data: BufferSource): Promise<ArrayBuffer> {
        const bytes = bytesFrom(data);
        const hashAlgo = typeof key.algo.hash === 'string' ? key.algo.hash : key.algo.hash?.name ?? 'SHA-256';
        const result = cryptoCall('crypto.hmac', {
          algorithm: hashAlgo,
          key: Array.from(key._raw),
          data: Array.from(bytes),
        }) as number[];
        void algorithm;
        return Uint8Array.from(result).buffer;
      },
    };
    const cryptoShim = {
      subtle,
      getRandomValues<T extends ArrayBufferView | null>(buf: T): T {
        if (!buf) return buf;
        const view = buf as unknown as ArrayBufferView;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const rand = cryptoCall('crypto.random', { size: bytes.length }) as number[];
        for (let i = 0; i < bytes.length && i < rand.length; i++) bytes[i] = rand[i]!;
        return buf;
      },
      randomUUID(): string {
        const b = new Uint8Array(16);
        (this as { getRandomValues: (b: Uint8Array) => Uint8Array }).getRandomValues(b);
        b[6] = (b[6]! & 0x0f) | 0x40;
        b[8] = (b[8]! & 0x3f) | 0x80;
        const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
        return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' + hex.slice(16, 20) + '-' + hex.slice(20);
      },
    };
    // Merge if partial crypto exists; else set fresh.
    if (gc) {
      if (!gc['subtle']) gc['subtle'] = subtle;
      if (!gc['getRandomValues']) gc['getRandomValues'] = cryptoShim.getRandomValues;
      if (!gc['randomUUID']) gc['randomUUID'] = cryptoShim.randomUUID;
    } else {
      g['crypto'] = cryptoShim;
    }
  }

  if (typeof g['TextDecoder'] === 'undefined') {
    class PolyTextDecoder {
      readonly encoding: string;
      readonly fatal: boolean;
      readonly ignoreBOM: boolean;
      constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean }) {
        this.encoding = (label ?? 'utf-8').toLowerCase();
        this.fatal = options?.fatal ?? false;
        this.ignoreBOM = options?.ignoreBOM ?? false;
        // We only support UTF-8-like encodings. latin1 also passes through
        // because a well-formed latin1 byte < 0x80 or between 0xa0-0xff
        // decodes to the same charCode in single-byte-per-char mode.
        if (this.encoding !== 'utf-8' && this.encoding !== 'utf8'
            && this.encoding !== 'latin1' && this.encoding !== 'iso-8859-1') {
          // Accept but treat as utf-8; libraries rarely branch on encoding.
        }
      }
      decode(input?: ArrayBufferView | ArrayBuffer, _options?: { stream?: boolean }): string {
        if (input === undefined) return '';
        let bytes: Uint8Array;
        if (input instanceof Uint8Array) bytes = input;
        else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
        else bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        // Latin1 fast path
        if (this.encoding === 'latin1' || this.encoding === 'iso-8859-1') {
          let s = '';
          for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
          return s;
        }
        // UTF-8 decode
        let s = '';
        let i = 0;
        while (i < bytes.length) {
          const b0 = bytes[i]!;
          if (b0 < 0x80) {
            s += String.fromCharCode(b0);
            i++;
          } else if ((b0 & 0xe0) === 0xc0 && i + 1 < bytes.length) {
            const b1 = bytes[i + 1]!;
            s += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
            i += 2;
          } else if ((b0 & 0xf0) === 0xe0 && i + 2 < bytes.length) {
            const b1 = bytes[i + 1]!;
            const b2 = bytes[i + 2]!;
            s += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
            i += 3;
          } else if ((b0 & 0xf8) === 0xf0 && i + 3 < bytes.length) {
            const b1 = bytes[i + 1]!;
            const b2 = bytes[i + 2]!;
            const b3 = bytes[i + 3]!;
            const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
            if (cp >= 0x10000) {
              const off = cp - 0x10000;
              s += String.fromCharCode(0xd800 + (off >> 10), 0xdc00 + (off & 0x3ff));
            } else {
              s += String.fromCharCode(cp);
            }
            i += 4;
          } else {
            // Malformed byte — fatal mode throws, else emit replacement char.
            if (this.fatal) throw new TypeError('The encoded data was not valid.');
            s += '\ufffd';
            i++;
          }
        }
        return s;
      }
    }
    g['TextDecoder'] = PolyTextDecoder;
  }
}

if (typeof (globalThis as { ipc?: unknown }).ipc === 'undefined') {
  (globalThis as Record<string, unknown>).evalQueue = [];
  (globalThis as Record<string, unknown>).ipc = {
    send: (msg: unknown, ignoreEval = true) => {
      print(JSON.stringify(msg));
      return (globalThis as { ipc: { recv: (i: boolean) => unknown } }).ipc.recv(ignoreEval);
    },
    recv: (ignoreEval: boolean) => {
      while (true) {
        const read = readline();
        if (!read) continue;
        const str = os.file.readFile('/comm');
        let msg: { type?: string; js?: string };
        if (str.startsWith('JS|')) msg = { type: 'eval', js: str.slice(3) };
        else msg = JSON.parse(str);
        if (msg.type === 'eval') {
          (globalThis as { evalQueue: unknown[] }).evalQueue.push(msg);
          if (ignoreEval) continue;
        }
        return msg;
      }
    },
  };
}

declare const drainJobQueue: (() => void) | undefined;

const ipc = (globalThis as { ipc: { send: (m: unknown, i?: boolean) => { js?: string } } }).ipc;

installNodeGlobals();
installRequire();
installESM();
installNet();

if (!(globalThis as Record<string, unknown>)['__process']) {
  (globalThis as Record<string, unknown>)['__process'] = {
    _exitCode: undefined as number | undefined,
    dispatch: (_pid: number, _event: string, _data: unknown) => {
    },
  };
}

while (true) {
  const reply = ipc.send({ type: 'wait' }, false);
  const js = (reply.js ?? '').replace(/\bimport\s*\(/g, '__import__(');
  try { (0, eval)('(async () => {' + js + '\n})()'); if (typeof drainJobQueue === 'function') drainJobQueue(); } catch (e) { print(JSON.stringify({ f: 'console.error', args: [String(e)] })); }
  const proc = (globalThis as Record<string, unknown>)['__process'] as { _exitCode?: number } | undefined;
  if (proc?._exitCode !== undefined) {
    ipc.send({ type: 'exit', exitCode: proc._exitCode });
    break;
  }
  ipc.send({ type: 'done' });
}
