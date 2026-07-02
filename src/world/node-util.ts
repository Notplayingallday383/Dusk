import { errnoToName } from './node-constants';

const kCustomInspect = Symbol.for('nodejs.util.inspect.custom');
const kCustomPromisify = Symbol.for('nodejs.util.promisify.custom');

// ---- promisify / callbackify ----

export const promisify = <T extends Function>(fn: T): Function => {
  if (typeof fn !== 'function') {
    const e = new TypeError('The "original" argument must be of type function');
    (e as Error & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  const custom = (fn as unknown as Record<symbol, unknown>)[kCustomPromisify];
  if (typeof custom === 'function') return custom as Function;
  const wrapped = function (this: unknown, ...args: unknown[]): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      try {
        (fn as Function).call(this, ...args, (err: unknown, ...results: unknown[]) => {
          if (err) reject(err);
          else if (results.length <= 1) resolve(results[0]);
          else resolve(results);
        });
      } catch (e) { reject(e); }
    });
  };
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  return wrapped;
};
(promisify as unknown as { custom: symbol }).custom = kCustomPromisify;

export const callbackify = <T extends (...args: unknown[]) => Promise<unknown>>(fn: T): Function => {
  if (typeof fn !== 'function') {
    const e = new TypeError('The "original" argument must be of type function');
    (e as Error & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
    throw e;
  }
  return function (this: unknown, ...args: unknown[]): void {
    const cb = args.pop();
    if (typeof cb !== 'function') {
      const e = new TypeError('The last argument must be of type function');
      (e as Error & { code?: string }).code = 'ERR_INVALID_ARG_TYPE';
      throw e;
    }
    try {
      const p = (fn as Function).apply(this, args) as Promise<unknown>;
      Promise.resolve(p).then(
        (value) => (cb as Function)(null, value),
        (err) => {
          if (err === null || err === undefined) {
            const wrapped = new Error('Promise was rejected with falsy value');
            (wrapped as Error & { reason?: unknown }).reason = err;
            (cb as Function)(wrapped);
          } else {
            (cb as Function)(err);
          }
        },
      );
    } catch (e) {
      (cb as Function)(e);
    }
  };
};

// ---- types.* ----

const tagOf = (v: unknown): string => Object.prototype.toString.call(v);

export const types = {
  isPromise: (v: unknown): boolean => tagOf(v) === '[object Promise]' || (typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'),
  isMap: (v: unknown): v is Map<unknown, unknown> => v instanceof Map,
  isSet: (v: unknown): v is Set<unknown> => v instanceof Set,
  isWeakMap: (v: unknown): v is WeakMap<object, unknown> => v instanceof WeakMap,
  isWeakSet: (v: unknown): v is WeakSet<object> => v instanceof WeakSet,
  isDate: (v: unknown): v is Date => v instanceof Date,
  isRegExp: (v: unknown): v is RegExp => v instanceof RegExp,
  isNativeError: (v: unknown): v is Error => v instanceof Error,
  isArrayBuffer: (v: unknown): v is ArrayBuffer => v instanceof ArrayBuffer,
  isSharedArrayBuffer: (v: unknown): boolean => typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer,
  isAnyArrayBuffer: (v: unknown): boolean => v instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && v instanceof SharedArrayBuffer),
  isDataView: (v: unknown): v is DataView => v instanceof DataView,
  isTypedArray: (v: unknown): boolean => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isUint8Array: (v: unknown): v is Uint8Array => v instanceof Uint8Array,
  isUint8ClampedArray: (v: unknown): v is Uint8ClampedArray => v instanceof Uint8ClampedArray,
  isUint16Array: (v: unknown): v is Uint16Array => v instanceof Uint16Array,
  isUint32Array: (v: unknown): v is Uint32Array => v instanceof Uint32Array,
  isInt8Array: (v: unknown): v is Int8Array => v instanceof Int8Array,
  isInt16Array: (v: unknown): v is Int16Array => v instanceof Int16Array,
  isInt32Array: (v: unknown): v is Int32Array => v instanceof Int32Array,
  isFloat32Array: (v: unknown): v is Float32Array => v instanceof Float32Array,
  isFloat64Array: (v: unknown): v is Float64Array => v instanceof Float64Array,
  isBigInt64Array: (v: unknown): boolean => typeof BigInt64Array !== 'undefined' && v instanceof BigInt64Array,
  isBigUint64Array: (v: unknown): boolean => typeof BigUint64Array !== 'undefined' && v instanceof BigUint64Array,
  isAsyncFunction: (v: unknown): boolean => typeof v === 'function' && tagOf(v) === '[object AsyncFunction]',
  isGeneratorFunction: (v: unknown): boolean => typeof v === 'function' && tagOf(v) === '[object GeneratorFunction]',
  isAsyncGeneratorFunction: (v: unknown): boolean => typeof v === 'function' && tagOf(v) === '[object AsyncGeneratorFunction]',
  isProxy: (_v: unknown): boolean => false,
  isModuleNamespaceObject: (v: unknown): boolean => v !== null && typeof v === 'object' && (v as Record<symbol, unknown>)[Symbol.toStringTag] === 'Module',
  isExternal: (_v: unknown): boolean => false,
  isBoxedPrimitive: (v: unknown): boolean => v instanceof Boolean || v instanceof Number || v instanceof String || v instanceof Symbol || (typeof BigInt !== 'undefined' && v instanceof (BigInt as unknown as Function)),
  isStringObject: (v: unknown): boolean => v instanceof String,
  isNumberObject: (v: unknown): boolean => v instanceof Number,
  isBooleanObject: (v: unknown): boolean => v instanceof Boolean,
  isSymbolObject: (v: unknown): boolean => Object(v) !== v ? false : tagOf(v) === '[object Symbol]' && !(typeof v === 'symbol'),
  isMapIterator: (v: unknown): boolean => tagOf(v) === '[object Map Iterator]',
  isSetIterator: (v: unknown): boolean => tagOf(v) === '[object Set Iterator]',
  isGeneratorObject: (v: unknown): boolean => tagOf(v) === '[object Generator]',
  isArgumentsObject: (v: unknown): boolean => tagOf(v) === '[object Arguments]',
};

// ---- inspect ----

export interface InspectOptions {
  depth?: number | null;
  colors?: boolean;
  showHidden?: boolean;
  customInspect?: boolean;
  breakLength?: number;
  maxArrayLength?: number | null;
  maxStringLength?: number | null;
  sorted?: boolean | ((a: string, b: string) => number);
  getters?: boolean | 'get' | 'set';
  compact?: boolean | number;
  numericSeparator?: boolean;
}

const isPrimitive = (v: unknown): boolean =>
  v === null || (typeof v !== 'object' && typeof v !== 'function');

const inspectPrimitive = (v: unknown): string => {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'number') {
    if (Object.is(v, -0)) return '-0';
    if (v !== v) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return String(v);
  }
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') {
    const name = (v as Function).name || 'anonymous';
    return `[Function: ${name}]`;
  }
  return String(v);
};

const truncStr = (s: string, max: number | null | undefined): string => {
  if (max == null || s.length <= max) return s;
  return s.slice(0, max) + '...';
};

const inspectInner = (value: unknown, opts: Required<InspectOptions>, depth: number, seen: Set<unknown>): string => {
  if (isPrimitive(value)) {
    if (typeof value === 'string') return truncStr(inspectPrimitive(value), opts.maxStringLength);
    return inspectPrimitive(value);
  }

  if (typeof value === 'function') return inspectPrimitive(value);

  if (seen.has(value)) return '[Circular]';

  if (opts.depth !== null && depth > opts.depth) {
    if (Array.isArray(value)) return '[Array]';
    if (value instanceof Map) return '[Map]';
    if (value instanceof Set) return '[Set]';
    return '[Object]';
  }

  if (opts.customInspect) {
    const custom = (value as Record<symbol, unknown>)[kCustomInspect];
    if (typeof custom === 'function') {
      try {
        const r = (custom as Function).call(value, depth, opts, (v: unknown, o?: InspectOptions) => inspect(v, { ...opts, ...o }));
        if (typeof r === 'string') return r;
        if (r !== value) return inspectInner(r, opts, depth, seen);
      } catch { /* */ }
    }
  }

  seen.add(value);
  try {
    if (value instanceof Date) {
      const s = isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
      return s;
    }
    if (value instanceof RegExp) return value.toString();
    if (value instanceof Error) {
      const stack = (value as Error & { stack?: string }).stack;
      return stack ?? `${value.name}: ${value.message}`;
    }
    if (value instanceof Promise) return 'Promise { <pending> }';

    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const max = opts.maxArrayLength ?? 100;
      const items: string[] = [];
      for (let i = 0; i < Math.min(value.length, max); i++) {
        items.push(inspectInner(value[i], opts, depth + 1, seen));
      }
      if (value.length > max) items.push(`... ${value.length - max} more items`);
      return `[ ${items.join(', ')} ]`;
    }

    if (value instanceof Map) {
      if (value.size === 0) return 'Map(0) {}';
      const items: string[] = [];
      let i = 0;
      const max = opts.maxArrayLength ?? 100;
      for (const [k, v] of value) {
        if (i++ >= max) { items.push(`... ${value.size - max} more`); break; }
        items.push(`${inspectInner(k, opts, depth + 1, seen)} => ${inspectInner(v, opts, depth + 1, seen)}`);
      }
      return `Map(${value.size}) { ${items.join(', ')} }`;
    }

    if (value instanceof Set) {
      if (value.size === 0) return 'Set(0) {}';
      const items: string[] = [];
      let i = 0;
      const max = opts.maxArrayLength ?? 100;
      for (const v of value) {
        if (i++ >= max) { items.push(`... ${value.size - max} more`); break; }
        items.push(inspectInner(v, opts, depth + 1, seen));
      }
      return `Set(${value.size}) { ${items.join(', ')} }`;
    }

    if (value instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer)) {
      const name = value instanceof ArrayBuffer ? 'ArrayBuffer' : 'SharedArrayBuffer';
      const u8 = new Uint8Array(value as ArrayBuffer);
      const max = opts.maxArrayLength ?? 50;
      const bytes: string[] = [];
      for (let i = 0; i < Math.min(u8.length, max); i++) {
        const b = u8[i]!;
        bytes.push(b.toString(16).padStart(2, '0'));
      }
      if (u8.length > max) bytes.push('...');
      return `${name} { [Uint8Contents]: <${bytes.join(' ')}> }`;
    }

    if (ArrayBuffer.isView(value)) {
      const name = (value.constructor as { name?: string }).name ?? 'TypedArray';
      const arr = value as unknown as ArrayLike<number | bigint>;
      const max = opts.maxArrayLength ?? 100;
      const items: string[] = [];
      for (let i = 0; i < Math.min(arr.length, max); i++) items.push(String(arr[i]));
      if (arr.length > max) items.push(`... ${arr.length - max} more`);
      return `${name}(${arr.length}) [ ${items.join(', ')} ]`;
    }

    const o = value as Record<string | symbol, unknown>;
    const ctor = (o.constructor as { name?: string } | undefined)?.name;
    const prefix = ctor && ctor !== 'Object' ? `${ctor} ` : '';
    let keys = Object.keys(o);
    if (opts.sorted) {
      const cmp = typeof opts.sorted === 'function' ? opts.sorted : undefined;
      keys = cmp ? keys.slice().sort(cmp) : keys.slice().sort();
    }
    if (opts.showHidden) {
      const all = Object.getOwnPropertyNames(o);
      for (const k of all) if (!keys.includes(k)) keys.push(k);
    }
    if (keys.length === 0) return `${prefix}{}`;
    const items: string[] = [];
    for (const k of keys) {
      const v = o[k];
      const keyStr = /^[A-Za-z_$][\w$]*$/.test(k) ? k : `'${k}'`;
      items.push(`${keyStr}: ${inspectInner(v, opts, depth + 1, seen)}`);
    }
    return `${prefix}{ ${items.join(', ')} }`;
  } finally {
    seen.delete(value);
  }
};

export const inspect = (value: unknown, opts?: InspectOptions | boolean): string => {
  const o: Required<InspectOptions> = {
    depth: 2,
    colors: false,
    showHidden: false,
    customInspect: true,
    breakLength: 80,
    maxArrayLength: 100,
    maxStringLength: 10000,
    sorted: false,
    getters: false,
    compact: 3,
    numericSeparator: false,
    ...(typeof opts === 'object' && opts !== null ? opts : {}),
  };
  if (typeof opts === 'boolean') o.showHidden = opts;
  return inspectInner(value, o, 0, new Set<unknown>());
};
(inspect as unknown as { custom: symbol }).custom = kCustomInspect;
(inspect as unknown as { defaultOptions: InspectOptions }).defaultOptions = {
  depth: 2, colors: false, showHidden: false, customInspect: true, breakLength: 80,
};

// ---- format ----

export const format = (...args: unknown[]): string => {
  if (args.length === 0) return '';
  const first = args[0];
  if (typeof first !== 'string') {
    return args.map((a) => typeof a === 'string' ? a : inspect(a)).join(' ');
  }
  let i = 1;
  const out: string[] = [];
  let p = 0;
  while (p < first.length) {
    const pct = first.indexOf('%', p);
    if (pct < 0 || pct + 1 >= first.length) { out.push(first.slice(p)); break; }
    out.push(first.slice(p, pct));
    const spec = first[pct + 1];
    if (spec === '%') { out.push('%'); p = pct + 2; continue; }
    if (i >= args.length) { out.push('%' + spec); p = pct + 2; continue; }
    const arg = args[i++];
    switch (spec) {
      case 's':
        if (arg === null || arg === undefined) out.push(String(arg));
        else if (typeof arg === 'object' || typeof arg === 'function') out.push(inspect(arg, { depth: 0 }));
        else out.push(String(arg));
        break;
      case 'd':
      case 'i':
        out.push(String(Math.trunc(Number(arg))));
        break;
      case 'f':
        out.push(String(Number(arg)));
        break;
      case 'j':
        try { out.push(JSON.stringify(arg)); } catch { out.push('[Circular]'); }
        break;
      case 'o':
        out.push(inspect(arg, { showHidden: true, depth: 4 }));
        break;
      case 'O':
        out.push(inspect(arg, { depth: 4 }));
        break;
      case 'c':
        // CSS styling — ignored
        break;
      default:
        out.push('%' + spec);
        i--;
        break;
    }
    p = pct + 2;
  }
  const rest = args.slice(i).map((a) => typeof a === 'string' ? a : inspect(a));
  return out.join('') + (rest.length ? ' ' + rest.join(' ') : '');
};

export const formatWithOptions = (opts: InspectOptions, ...args: unknown[]): string => {
  if (args.length === 0) return '';
  if (typeof args[0] !== 'string') return args.map((a) => typeof a === 'string' ? a : inspect(a, opts)).join(' ');
  return format(...args);
};

// ---- inherits ----

export const inherits = (ctor: Function, superCtor: Function): void => {
  if (typeof ctor !== 'function') throw new TypeError('The constructor must be a function');
  if (typeof superCtor !== 'function') throw new TypeError('The super constructor must be a function');
  (ctor as unknown as Record<string, unknown>)['super_'] = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
};

// ---- isDeepStrictEqual ----

const objKeys = (o: object): (string | symbol)[] => {
  const keys: (string | symbol)[] = Object.getOwnPropertyNames(o);
  for (const s of Object.getOwnPropertySymbols(o)) {
    const desc = Object.getOwnPropertyDescriptor(o, s);
    if (desc && desc.enumerable) keys.push(s);
  }
  return keys;
};

export const isDeepStrictEqual = (a: unknown, b: unknown): boolean => {
  return _deep(a, b, new Map<unknown, unknown>());
};

const _deep = (a: unknown, b: unknown, seen: Map<unknown, unknown>): boolean => {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (typeof a !== 'object') return false;

  // Tag/class check
  if (Object.getPrototypeOf(a as object) !== Object.getPrototypeOf(b as object)) return false;

  const prev = seen.get(a);
  if (prev !== undefined) return prev === b;
  seen.set(a, b);

  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof RegExp && b instanceof RegExp) return a.source === b.source && a.flags === b.flags;
  if (a instanceof ArrayBuffer && b instanceof ArrayBuffer) {
    if (a.byteLength !== b.byteLength) return false;
    const av = new Uint8Array(a), bv = new Uint8Array(b);
    for (let i = 0; i < a.byteLength; i++) if (av[i] !== bv[i]) return false;
    return true;
  }
  if (ArrayBuffer.isView(a) && ArrayBuffer.isView(b)) {
    if (a.byteLength !== b.byteLength) return false;
    const av = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    const bv = new Uint8Array((b as ArrayBufferView).buffer, (b as ArrayBufferView).byteOffset, b.byteLength);
    for (let i = 0; i < av.length; i++) if (av[i] !== bv[i]) return false;
    return true;
  }
  if (a instanceof Map && b instanceof Map) {
    if (a.size !== b.size) return false;
    for (const [k, v] of a) {
      if (!b.has(k)) return false;
      if (!_deep(v, b.get(k), seen)) return false;
    }
    return true;
  }
  if (a instanceof Set && b instanceof Set) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!_deep(a[i], b[i], seen)) return false;
    return true;
  }

  const ao = a as Record<string | symbol, unknown>;
  const bo = b as Record<string | symbol, unknown>;
  const ak = objKeys(ao);
  const bk = objKeys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k as string)) return false;
    if (!_deep(ao[k], bo[k], seen)) return false;
  }
  return true;
};

// ---- deprecate ----

export const deprecate = <T extends Function>(fn: T, msg: string, code?: string): T => {
  let warned = false;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (!warned) {
      warned = true;
      const g = globalThis as Record<string, unknown>;
      const c = g['console'] as { warn?: (...a: unknown[]) => void; error?: (...a: unknown[]) => void } | undefined;
      const out = c?.warn ?? c?.error;
      if (out) out(`(node:DeprecationWarning) ${code ? `[${code}] ` : ''}${msg}`);
    }
    return (fn as Function).apply(this, args);
  };
  Object.setPrototypeOf(wrapped, Object.getPrototypeOf(fn));
  return wrapped as unknown as T;
};

// ---- parseArgs (Node 18+ subset) ----

interface ParseArgsOptionConfig {
  type: 'string' | 'boolean';
  short?: string;
  multiple?: boolean;
  default?: string | boolean | string[] | boolean[];
}

interface ParseArgsConfig {
  args?: string[];
  options?: Record<string, ParseArgsOptionConfig>;
  strict?: boolean;
  allowPositionals?: boolean;
  tokens?: boolean;
}

interface ParseArgsResult {
  values: Record<string, string | boolean | string[] | boolean[] | undefined>;
  positionals: string[];
}

export const parseArgs = (config: ParseArgsConfig = {}): ParseArgsResult => {
  const g = globalThis as Record<string, unknown>;
  const proc = g['process'] as { argv?: string[] } | undefined;
  const args = config.args ?? (proc?.argv ? proc.argv.slice(2) : []);
  const options = config.options ?? {};
  const allowPositionals = config.allowPositionals ?? false;
  const strict = config.strict ?? true;

  const values: Record<string, string | boolean | string[] | boolean[] | undefined> = {};
  const positionals: string[] = [];

  const shortMap = new Map<string, string>();
  for (const [name, cfg] of Object.entries(options)) {
    if (cfg.short) shortMap.set(cfg.short, name);
    if (cfg.default !== undefined) values[name] = cfg.default;
  }

  let i = 0;
  while (i < args.length) {
    const arg = args[i++]!;
    if (arg === '--') {
      while (i < args.length) positionals.push(args[i++]!);
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      const cfg = options[name];
      if (!cfg) {
        if (strict) {
          const e = new TypeError(`Unknown option '--${name}'`);
          (e as Error & { code?: string }).code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
          throw e;
        }
        continue;
      }
      if (cfg.type === 'boolean') {
        if (cfg.multiple) {
          const arr = (values[name] as boolean[] | undefined) ?? [];
          arr.push(true);
          values[name] = arr;
        } else {
          values[name] = true;
        }
      } else {
        const v = eq >= 0 ? arg.slice(eq + 1) : (args[i++] ?? '');
        if (cfg.multiple) {
          const arr = (values[name] as string[] | undefined) ?? [];
          arr.push(v);
          values[name] = arr;
        } else {
          values[name] = v;
        }
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      const short = arg.slice(1);
      const name = shortMap.get(short);
      if (!name) {
        if (strict) {
          const e = new TypeError(`Unknown option '-${short}'`);
          (e as Error & { code?: string }).code = 'ERR_PARSE_ARGS_UNKNOWN_OPTION';
          throw e;
        }
        continue;
      }
      const cfg = options[name]!;
      if (cfg.type === 'boolean') {
        if (cfg.multiple) {
          const arr = (values[name] as boolean[] | undefined) ?? [];
          arr.push(true);
          values[name] = arr;
        } else {
          values[name] = true;
        }
      } else {
        const v = args[i++] ?? '';
        if (cfg.multiple) {
          const arr = (values[name] as string[] | undefined) ?? [];
          arr.push(v);
          values[name] = arr;
        } else {
          values[name] = v;
        }
      }
    } else {
      if (!allowPositionals && strict) {
        const e = new TypeError(`Positional arguments not allowed`);
        (e as Error & { code?: string }).code = 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL';
        throw e;
      }
      positionals.push(arg);
    }
  }
  return { values, positionals };
};

// ---- TextEncoder / TextDecoder (pure JS, exposed via util only) ----

class _TextEncoder {
  readonly encoding = 'utf-8';
  encode(input = ''): Uint8Array {
    const str = String(input);
    const out: number[] = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) { out.push(c); }
      else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
      else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
        const c2 = str.charCodeAt(i + 1);
        if (c2 >= 0xdc00 && c2 <= 0xdfff) {
          const cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
          out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
          i++;
        } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      } else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return Uint8Array.from(out);
  }
  encodeInto(input: string, dest: Uint8Array): { read: number; written: number } {
    const bytes = this.encode(input);
    const n = Math.min(bytes.length, dest.length);
    dest.set(bytes.subarray(0, n));
    return { read: input.length, written: n };
  }
}

class _TextDecoder {
  readonly encoding: string;
  readonly fatal: boolean;
  readonly ignoreBOM: boolean;
  constructor(label = 'utf-8', opts: { fatal?: boolean; ignoreBOM?: boolean } = {}) {
    this.encoding = label.toLowerCase();
    this.fatal = !!opts.fatal;
    this.ignoreBOM = !!opts.ignoreBOM;
  }
  decode(input?: BufferSource): string {
    if (!input) return '';
    let bytes: Uint8Array;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else bytes = new Uint8Array((input as ArrayBufferView).buffer, (input as ArrayBufferView).byteOffset, (input as ArrayBufferView).byteLength);
    let s = '';
    let i = 0;
    while (i < bytes.length) {
      const b1 = bytes[i++]!;
      if (b1 < 0x80) { s += String.fromCharCode(b1); continue; }
      if (b1 < 0xc0) { s += '\ufffd'; continue; }
      if (b1 < 0xe0) {
        const b2 = bytes[i++];
        if (b2 === undefined) { s += '\ufffd'; break; }
        s += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
        continue;
      }
      if (b1 < 0xf0) {
        const b2 = bytes[i++]; const b3 = bytes[i++];
        if (b2 === undefined || b3 === undefined) { s += '\ufffd'; break; }
        s += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
        continue;
      }
      const b2 = bytes[i++]; const b3 = bytes[i++]; const b4 = bytes[i++];
      if (b2 === undefined || b3 === undefined || b4 === undefined) { s += '\ufffd'; break; }
      const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
      const off = cp - 0x10000;
      s += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff));
    }
    return s;
  }
}

export const TextEncoder = (typeof globalThis !== 'undefined' && (globalThis as { TextEncoder?: unknown }).TextEncoder) ? (globalThis as { TextEncoder: typeof _TextEncoder }).TextEncoder : _TextEncoder;
export const TextDecoder = (typeof globalThis !== 'undefined' && (globalThis as { TextDecoder?: unknown }).TextDecoder) ? (globalThis as { TextDecoder: typeof _TextDecoder }).TextDecoder : _TextDecoder;

// ---- error helpers ----

export const getSystemErrorName = (errno: number): string => {
  if (errno < 0) errno = -errno;
  return errnoToName(errno) ?? `Unknown system error ${errno}`;
};

export const getSystemErrorMap = (): Map<number, [string, string]> => {
  const map = new Map<number, [string, string]>();
  const seen = new Set<number>();
  for (const [name, num] of Object.entries({ /* re-import via dynamic require would be nicer */ }) as [string, number][]) {
    if (!seen.has(num)) {
      seen.add(num);
      map.set(num, [name, name]);
    }
  }
  return map;
};

// ---- misc ----

export const debuglog = (_section: string): ((...args: unknown[]) => void) => {
  return () => undefined;
};
export const debug = debuglog;

export const stripVTControlCharacters = (s: string): string =>
  s.replace(/\x1b\[[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g, '');

export const styleText = (_style: string | string[], text: string): string => String(text);

export const nodeUtil = {
  promisify,
  callbackify,
  types,
  inspect,
  format,
  formatWithOptions,
  inherits,
  isDeepStrictEqual,
  deprecate,
  parseArgs,
  TextEncoder,
  TextDecoder,
  getSystemErrorName,
  getSystemErrorMap,
  debuglog,
  debug,
  stripVTControlCharacters,
  styleText,
};
