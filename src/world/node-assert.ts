import { isDeepStrictEqual } from './node-util';

export class AssertionError extends Error {
  override name = 'AssertionError';
  code = 'ERR_ASSERTION';
  actual: unknown;
  expected: unknown;
  operator: string;
  generatedMessage: boolean;

  constructor(opts: { message?: string; actual?: unknown; expected?: unknown; operator?: string; stackStartFn?: Function }) {
    const generated = !opts.message;
    super(opts.message ?? `${formatValue(opts.actual)} ${opts.operator ?? '!='} ${formatValue(opts.expected)}`);
    this.actual = opts.actual;
    this.expected = opts.expected;
    this.operator = opts.operator ?? '';
    this.generatedMessage = generated;
    const cs = (Error as unknown as { captureStackTrace?: (e: Error, c: Function) => void }).captureStackTrace;
    if (cs && opts.stackStartFn) cs(this, opts.stackStartFn);
  }
}

const formatValue = (v: unknown): string => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (typeof v === 'object') try { return JSON.stringify(v); } catch { return String(v); }
  return String(v);
};

const fail = (msg: string, actual: unknown, expected: unknown, operator: string, stackStartFn: Function): never => {
  throw new AssertionError({ message: msg, actual, expected, operator, stackStartFn });
};

export function ok(value: unknown, message?: string | Error): asserts value {
  if (!value) {
    if (message instanceof Error) throw message;
    fail(message ?? `${formatValue(value)} == true`, value, true, '==', ok);
  }
}

export const assert = ok;

export const equal = (actual: unknown, expected: unknown, message?: string | Error): void => {
  // eslint-disable-next-line eqeqeq
  if (actual != expected) {
    if (message instanceof Error) throw message;
    fail(message ?? `${formatValue(actual)} == ${formatValue(expected)}`, actual, expected, '==', equal);
  }
};

export const notEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  // eslint-disable-next-line eqeqeq
  if (actual == expected) {
    if (message instanceof Error) throw message;
    fail(message ?? `${formatValue(actual)} != ${formatValue(expected)}`, actual, expected, '!=', notEqual);
  }
};

export const strictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  if (!Object.is(actual, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `${formatValue(actual)} === ${formatValue(expected)}`, actual, expected, 'strictEqual', strictEqual);
  }
};

export const notStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  if (Object.is(actual, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `${formatValue(actual)} !== ${formatValue(expected)}`, actual, expected, 'notStrictEqual', notStrictEqual);
  }
};

export const deepEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  if (!isDeepStrictEqual(actual, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Expected values to be loosely deep-equal`, actual, expected, 'deepEqual', deepEqual);
  }
};

export const deepStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  if (!isDeepStrictEqual(actual, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Expected values to be strictly deep-equal`, actual, expected, 'deepStrictEqual', deepStrictEqual);
  }
};

export const notDeepEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  if (isDeepStrictEqual(actual, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Expected values to be loosely not deep-equal`, actual, expected, 'notDeepEqual', notDeepEqual);
  }
};

export const notDeepStrictEqual = (actual: unknown, expected: unknown, message?: string | Error): void => {
  if (isDeepStrictEqual(actual, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Expected values to be strictly not deep-equal`, actual, expected, 'notDeepStrictEqual', notDeepStrictEqual);
  }
};

const matchesError = (err: unknown, expected: unknown): boolean => {
  if (expected === undefined) return true;
  if (expected instanceof RegExp) return expected.test(err instanceof Error ? err.message : String(err));
  if (typeof expected === 'function') {
    if (expected === Error || expected.prototype instanceof Error) return err instanceof (expected as { new(): Error });
    return (expected as (e: unknown) => boolean)(err) === true;
  }
  if (typeof expected === 'string') return (err instanceof Error ? err.message : String(err)).includes(expected);
  if (expected !== null && typeof expected === 'object') {
    const o = expected as Record<string, unknown>;
    const e = err as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (o[k] instanceof RegExp) { if (!(o[k] as RegExp).test(String(e[k]))) return false; }
      else if (!isDeepStrictEqual(e[k], o[k])) return false;
    }
    return true;
  }
  return false;
};

export const throws = (fn: () => unknown, expected?: unknown, message?: string | Error): void => {
  let threw = false;
  let caught: unknown;
  try { fn(); } catch (e) { threw = true; caught = e; }
  if (!threw) {
    if (message instanceof Error) throw message;
    fail(message ?? `Missing expected exception`, undefined, expected, 'throws', throws);
  }
  if (!matchesError(caught, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Got unwanted exception`, caught, expected, 'throws', throws);
  }
};

export const doesNotThrow = (fn: () => unknown, expected?: unknown, message?: string | Error): void => {
  let threw = false;
  let caught: unknown;
  try { fn(); } catch (e) { threw = true; caught = e; }
  if (threw && matchesError(caught, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Got unwanted exception`, caught, expected, 'doesNotThrow', doesNotThrow);
  }
  if (threw) throw caught;
};

export const rejects = async (
  fn: (() => Promise<unknown>) | Promise<unknown>,
  expected?: unknown,
  message?: string | Error,
): Promise<void> => {
  let threw = false;
  let caught: unknown;
  try {
    const p = typeof fn === 'function' ? (fn as () => Promise<unknown>)() : fn;
    await p;
  } catch (e) {
    threw = true; caught = e;
  }
  if (!threw) {
    if (message instanceof Error) throw message;
    fail(message ?? `Missing expected rejection`, undefined, expected, 'rejects', rejects as unknown as Function);
  }
  if (!matchesError(caught, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Got unwanted rejection`, caught, expected, 'rejects', rejects as unknown as Function);
  }
};

export const doesNotReject = async (
  fn: (() => Promise<unknown>) | Promise<unknown>,
  expected?: unknown,
  message?: string | Error,
): Promise<void> => {
  let threw = false;
  let caught: unknown;
  try {
    const p = typeof fn === 'function' ? (fn as () => Promise<unknown>)() : fn;
    await p;
  } catch (e) {
    threw = true; caught = e;
  }
  if (threw && matchesError(caught, expected)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Got unwanted rejection`, caught, expected, 'doesNotReject', doesNotReject as unknown as Function);
  }
  if (threw) throw caught;
};

export const match = (actual: string, regex: RegExp, message?: string | Error): void => {
  if (!regex.test(actual)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Input did not match regex`, actual, regex, 'match', match);
  }
};

export const doesNotMatch = (actual: string, regex: RegExp, message?: string | Error): void => {
  if (regex.test(actual)) {
    if (message instanceof Error) throw message;
    fail(message ?? `Input matched regex unexpectedly`, actual, regex, 'doesNotMatch', doesNotMatch);
  }
};

export const ifError = (value: unknown): void => {
  if (value !== null && value !== undefined) {
    const e = new AssertionError({
      message: `ifError got unwanted exception: ${value instanceof Error ? value.message : String(value)}`,
      actual: value,
      expected: null,
      operator: 'ifError',
      stackStartFn: ifError,
    });
    if (value instanceof Error && value.stack) e.stack = value.stack;
    throw e;
  }
};

const _fail = (...args: unknown[]): never => {
  let actual: unknown, expected: unknown, message: string | Error | undefined, operator = 'fail';
  if (args.length === 1) message = args[0] as string | Error;
  else if (args.length === 2) { actual = args[0]; message = args[1] as string | Error; }
  else { actual = args[0]; expected = args[1]; message = args[2] as string | Error; operator = (args[3] as string) ?? 'fail'; }
  if (message instanceof Error) throw message;
  fail(message ?? 'Failed', actual, expected, operator, _fail);
  throw new Error('unreachable');
};

const assertStrict = {
  ok,
  equal: strictEqual,
  notEqual: notStrictEqual,
  strictEqual,
  notStrictEqual,
  deepEqual: deepStrictEqual,
  notDeepEqual: notDeepStrictEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  match,
  doesNotMatch,
  ifError,
  fail: _fail,
  AssertionError,
};

export const strict = Object.assign(ok.bind(undefined), assertStrict);

const assertExport = Object.assign(ok.bind(undefined), {
  ok,
  equal,
  notEqual,
  strictEqual,
  notStrictEqual,
  deepEqual,
  notDeepEqual,
  deepStrictEqual,
  notDeepStrictEqual,
  throws,
  doesNotThrow,
  rejects,
  doesNotReject,
  match,
  doesNotMatch,
  ifError,
  fail: _fail,
  AssertionError,
  strict,
  default: undefined as unknown,
});
(assertExport as unknown as { default: unknown }).default = assertExport;

export const nodeAssert = assertExport;
