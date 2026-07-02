import { describe, expect, it } from 'vitest';
import { codes } from '../src/world/node-errors';

describe('ERR_INVALID_* family', () => {
  it('ERR_INVALID_OBJECT_DEFINE_PROPERTY produces TypeError with code', () => {
    const e = codes['ERR_INVALID_OBJECT_DEFINE_PROPERTY']!('foo');
    expect(e).toBeInstanceOf(TypeError);
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_OBJECT_DEFINE_PROPERTY');
    expect(e.message).toContain('foo');
  });

  it('ERR_INVALID_RETURN_PROPERTY_VALUE includes expected/actual', () => {
    const e = codes['ERR_INVALID_RETURN_PROPERTY_VALUE']!('string', 'load', 'format', 42);
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_RETURN_PROPERTY_VALUE');
    expect(e.message).toContain('"format"');
    expect(e.message).toContain('load');
  });

  it('ERR_INVALID_RETURN_PROPERTY includes property name', () => {
    const e = codes['ERR_INVALID_RETURN_PROPERTY']!('string', 'load', 'format');
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_RETURN_PROPERTY');
    expect(e.message).toContain('"format"');
  });

  it('ERR_INVALID_THIS_VARIANT', () => {
    const e = codes['ERR_INVALID_THIS_VARIANT']!('URL', 'URL or URLSearchParams');
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_THIS_VARIANT');
  });

  it('ERR_INVALID_TRANSFER_OBJECT', () => {
    const e = codes['ERR_INVALID_TRANSFER_OBJECT']!({});
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_TRANSFER_OBJECT');
  });

  it('ERR_INVALID_IP_ADDRESS', () => {
    const e = codes['ERR_INVALID_IP_ADDRESS']!('not.an.ip');
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_IP_ADDRESS');
    expect(e.message).toContain('not.an.ip');
  });

  it('ERR_INVALID_ARG_TYPE_RANGE', () => {
    const e = codes['ERR_INVALID_ARG_TYPE_RANGE']!('len', 'a positive integer', -1);
    expect(e).toBeInstanceOf(RangeError);
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_ARG_TYPE_RANGE');
  });

  it('ERR_INVALID_PERFORMANCE_MEASURE', () => {
    const e = codes['ERR_INVALID_PERFORMANCE_MEASURE']!('startMark missing');
    expect((e as Error & { code: string }).code).toBe('ERR_INVALID_PERFORMANCE_MEASURE');
  });
});

describe('ERR_HTTP2_* family', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_HTTP2_ALTSVC_LENGTH', []],
    ['ERR_HTTP2_CONNECT_AUTHORITY', []],
    ['ERR_HTTP2_CONNECT_PATH', []],
    ['ERR_HTTP2_CONNECT_SCHEME', []],
    ['ERR_HTTP2_ERROR', [1]],
    ['ERR_HTTP2_GOAWAY_SESSION', []],
    ['ERR_HTTP2_HEADERS_AFTER_RESPOND', []],
    ['ERR_HTTP2_HEADERS_SENT', []],
    ['ERR_HTTP2_HEADER_REQUIRED', [':status']],
    ['ERR_HTTP2_HEADER_SINGLE_VALUE', [':status']],
    ['ERR_HTTP2_INFO_STATUS_NOT_ALLOWED', []],
    ['ERR_HTTP2_INVALID_CONNECTION_HEADERS', ['keep-alive']],
    ['ERR_HTTP2_INVALID_HEADER_VALUE', ['', 'x']],
    ['ERR_HTTP2_INVALID_INFO_STATUS', [199]],
    ['ERR_HTTP2_INVALID_ORIGIN', []],
    ['ERR_HTTP2_INVALID_PACKED_SETTINGS_LENGTH', []],
    ['ERR_HTTP2_INVALID_PSEUDOHEADER', [':bogus']],
    ['ERR_HTTP2_INVALID_SESSION', []],
    ['ERR_HTTP2_INVALID_SETTING_VALUE', ['enablePush', 7]],
    ['ERR_HTTP2_INVALID_STREAM', []],
    ['ERR_HTTP2_MAX_PENDING_SETTINGS_ACK', []],
    ['ERR_HTTP2_NESTED_PUSH', []],
    ['ERR_HTTP2_NO_SOCKET_MANIPULATION', []],
    ['ERR_HTTP2_ORIGIN_LENGTH', []],
    ['ERR_HTTP2_OUT_OF_STREAMS', []],
    ['ERR_HTTP2_PAYLOAD_FORBIDDEN', [204]],
    ['ERR_HTTP2_PING_CANCEL', []],
    ['ERR_HTTP2_PING_LENGTH', []],
    ['ERR_HTTP2_PSEUDOHEADER_NOT_ALLOWED', []],
    ['ERR_HTTP2_PUSH_DISABLED', []],
    ['ERR_HTTP2_SEND_FILE', []],
    ['ERR_HTTP2_SEND_FILE_NOSEEK', []],
    ['ERR_HTTP2_SESSION_ERROR', [1]],
    ['ERR_HTTP2_SETTINGS_CANCEL', []],
    ['ERR_HTTP2_SOCKET_BOUND', []],
    ['ERR_HTTP2_SOCKET_UNBOUND', []],
    ['ERR_HTTP2_STATUS_101', []],
    ['ERR_HTTP2_STATUS_INVALID', [99]],
    ['ERR_HTTP2_STREAM_CANCEL', []],
    ['ERR_HTTP2_STREAM_ERROR', [1]],
    ['ERR_HTTP2_STREAM_SELF_DEPENDENCY', []],
    ['ERR_HTTP2_TRAILERS_ALREADY_SENT', []],
    ['ERR_HTTP2_TRAILERS_NOT_READY', []],
    ['ERR_HTTP2_UNSUPPORTED_PROTOCOL', ['ftp']],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('ERR_STREAM_* / queue gap-fill', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_STREAM_WRITE_AFTER_DESTROY', []],
    ['ERR_STREAM_RELEASE_LOCK', []],
    ['ERR_STREAM_HAS_STRINGDECODER', []],
    ['ERR_MULTIPLE_RESOLVES', ['resolve', 'fulfilled', 'oops']],
    ['ERR_QUEUE_FULL', []],
    ['ERR_QUEUE_CLOSED', []],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('ERR_CRYPTO_* / ERR_TLS_* tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_CRYPTO_INVALID_KEY', []],
    ['ERR_CRYPTO_INVALID_MESSAGELEN', []],
    ['ERR_CRYPTO_OPERATION_FAILED', ['encrypt']],
    ['ERR_CRYPTO_INVALID_KEYTYPE', ['public', 'private']],
    ['ERR_CRYPTO_INCOMPATIBLE_KEY', ['signing', 'symmetric key']],
    ['ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS', ['encoding', 'public encoded data']],
    ['ERR_TLS_PSK_SET_IDENTIY_HINT_FAILED', []],
    ['ERR_TLS_ALPN_CALLBACK_INVALID_RESULT', ['xx', ['h2']]],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('ERR_MODULE_* / package resolution tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_IMPORT_ATTRIBUTE_TYPE_INCOMPATIBLE', ['./x.json', 'json']],
    ['ERR_IMPORT_ATTRIBUTE_UNSUPPORTED', ['type', 'csv']],
    ['ERR_IMPORT_ASSERTION_TYPE_FAILED', ['./x', 'json']],
    ['ERR_IMPORT_ASSERTION_TYPE_MISSING', ['./x', 'json']],
    ['ERR_IMPORT_ASSERTION_TYPE_UNSUPPORTED', ['csv']],
    ['ERR_MODULE_NOT_FOUND_PACKAGE_PATH', ['./x', 'file:///pkg']],
    ['ERR_VM_MODULE_NOT_LINKED', []],
    ['ERR_MANIFEST_ASSERT_INTEGRITY', ['file:///x', 'sha512-…']],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('ERR_FS_* tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_FS_RMDIR_ENOTDIR', ['/foo']],
    ['ERR_FS_INVALID_OPTIONS', ['recursive must be a boolean']],
    ['ERR_FS_INVALID_DIR_HANDLE', []],
    ['ERR_FS_CHANGED_HANDLE', []],
    ['ERR_FS_WATCHER_ALREADY_STARTED', []],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('worker / IPC tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_WORKER_MESSAGING_ERRORED', []],
    ['ERR_WORKER_MESSAGING_FAILED', []],
    ['ERR_WORKER_MESSAGING_SAME_THREAD', []],
    ['ERR_WORKER_MESSAGING_TIMEOUT', []],
    ['ERR_MESSAGE_TARGET_CONTEXT_UNAVAILABLE', []],
    ['ERR_CLOSED_MESSAGE_PORT', []],
    ['ERR_IPC_ONE_PIPE', []],
    ['ERR_IPC_SYNC_FORK', []],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('DNS / socket / net tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_NET_INVALID_HOSTNAME', ['..bad..']],
    ['ERR_DNS_INVALID_HOSTNAME', ['..bad..']],
    ['ERR_SOCKET_BAD_BUFFER_SIZE', []],
    ['ERR_SOCKET_BAD_FAMILY', ['foo']],
    ['ERR_SOCKET_BAD_ADDRESS', ['999.999.999.999']],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('child_process tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_OUT_OF_RANGE_STDIO', ['stdio', '>= 0', -1]],
    ['ERR_CHILD_PROCESS_FORK_OPTIONS', ['silent must be boolean']],
    ['ERR_CHILD_PROCESS_FAILED', ['exec', 1]],
    ['ERR_INVALID_STDIO_TYPE', [42]],
    ['ERR_PROCESS_KILL_FAILED', [1234, 'SIGTERM']],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('misc tail', () => {
  const cases: Array<[string, unknown[]]> = [
    ['ERR_BROTLI_INVALID_PARAM', [42]],
    ['ERR_BROTLI_COMPRESSION_FAILED', []],
    ['ERR_ZLIB_BINDING_CLOSED', []],
    ['ERR_ZLIB_OPERATION_FAILED', ['deflate']],
    ['ERR_PERFORMANCE_INVALID_TIMESTAMP', [-1]],
    ['ERR_PERFORMANCE_MEASURE_INVALID_OPTIONS', ['start required']],
    ['ERR_REPL_EVAL_CONFIG', []],
    ['ERR_REPL_INPUT_TOO_LONG', []],
    ['ERR_TEST_TIMEOUT', [5000]],
    ['ERR_VM_DYNAMIC_IMPORT_CALLBACK_MISSING_FLAG', []],
    ['ERR_SOURCE_MAP_CANNOT_LOAD', ['file:///x.map', 'not json']],
    ['ERR_SOURCE_MAP_MISSING_SOURCE', ['file:///x.ts', 'file:///x.js']],
  ];
  for (const [code, args] of cases) {
    it(code, () => {
      const fn = codes[code];
      expect(fn, `factory missing: ${code}`).toBeTypeOf('function');
      const e = fn!(...(args as unknown[]));
      expect((e as Error & { code: string }).code).toBe(code);
    });
  }
});

describe('coverage: every factory key matches its produced err.code', () => {
  const keys = Object.keys(codes);

  it('non-empty registry', () => {
    expect(keys.length).toBeGreaterThan(250);
  });

  for (const key of keys) {
    it(`${key}`, () => {
      const fn = codes[key]!;
      let err: unknown;
      try {
        // 5 undefined args covers every current factory's positional list
        err = fn(undefined, undefined, undefined, undefined, undefined);
      } catch (e) {
        // makeError itself should never throw; surface unexpected throws clearly
        throw new Error(`${key} threw while constructing: ${String(e)}`);
      }
      expect(err).toBeInstanceOf(Error);
      const c = (err as Error & { code?: unknown }).code;
      expect(c, `${key}: factory produced err.code=${String(c)}`).toBe(key);
      expect(typeof (err as Error).message).toBe('string');
      expect((err as Error).message.length).toBeGreaterThan(0);
    });
  }
});
