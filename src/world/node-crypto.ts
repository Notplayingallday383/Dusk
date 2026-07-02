declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };
import { codes, errnoError } from './node-errors';

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) {
    const m = /^([A-Z_]+):/.exec(r.error);
    const code = m && m[1] ? m[1] : 'UNKNOWN';
    // Crypto host errors are usually ERR_CRYPTO_* style; if we recognize one, use the factory.
    const factory = codes[code];
    if (factory) throw factory(r.error);
    const syscall = f.replace(/^crypto\./, '');
    throw errnoError(code, syscall, undefined, r.error);
  }
  return r.value;
};

const u8FromArrayLike = (v: number[] | Uint8Array): Uint8Array =>
  v instanceof Uint8Array ? v : Uint8Array.from(v);

const toBytes = (data: unknown, encoding: string = 'utf8'): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === 'string') {
    const g = globalThis as Record<string, unknown>;
    const Buffer = g['Buffer'] as undefined | { from(s: string, enc?: string): Uint8Array };
    if (Buffer) return Buffer.from(data, encoding);
    // fallback: utf8 only
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) {
      let c = data.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return Uint8Array.from(out);
  }
  if (ArrayBuffer.isView(data)) return new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw codes.ERR_INVALID_ARG_TYPE!('data', ['string', 'Buffer', 'Uint8Array', 'ArrayBuffer'], data);
};

const bytesToBuffer = (bytes: Uint8Array): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): Uint8Array };
  if (Buffer) return Buffer.from(bytes);
  return bytes;
};

// ---- random ----

const getRandomValues = (buf: Uint8Array): Uint8Array => {
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(buf);
    return buf;
  }
  const arr = __call('crypto.random', { size: buf.length }) as number[];
  for (let i = 0; i < arr.length; i++) buf[i] = arr[i] ?? 0;
  return buf;
};

export const randomBytes = (size: number, cb?: (err: Error | null, buf?: Uint8Array) => void): Uint8Array | undefined => {
  if (typeof size !== 'number' || size < 0 || !Number.isInteger(size)) {
    const e = codes.ERR_OUT_OF_RANGE!('size', '>= 0 && integer', size);
    if (cb) { cb(e as Error); return; }
    throw e;
  }
  const buf = new Uint8Array(size);
  getRandomValues(buf);
  const out = bytesToBuffer(buf);
  if (cb) {
    Promise.resolve().then(() => cb(null, out));
    return undefined;
  }
  return out;
};

export const randomFillSync = (buf: Uint8Array, offset = 0, size?: number): Uint8Array => {
  const len = size ?? buf.length - offset;
  const tmp = new Uint8Array(len);
  getRandomValues(tmp);
  buf.set(tmp, offset);
  return buf;
};

export const randomFill = (buf: Uint8Array, ...rest: unknown[]): void => {
  let offset = 0, size = buf.length, cb: Function | undefined;
  if (rest.length === 1) cb = rest[0] as Function;
  else if (rest.length === 2) { offset = rest[0] as number; cb = rest[1] as Function; }
  else if (rest.length === 3) { offset = rest[0] as number; size = rest[1] as number; cb = rest[2] as Function; }
  try {
    randomFillSync(buf, offset, size);
    if (cb) Promise.resolve().then(() => cb!(null, buf));
  } catch (e) {
    if (cb) Promise.resolve().then(() => cb!(e));
  }
};

export const randomInt = (...args: number[]): number => {
  let min = 0, max: number;
  if (args.length === 1) max = args[0]!;
  else { min = args[0]!; max = args[1]!; }
  const range = max - min;
  if (range <= 0) throw codes.ERR_OUT_OF_RANGE!('max', '> min', max);
  const buf = new Uint8Array(6);
  getRandomValues(buf);
  let n = 0;
  for (let i = 0; i < 6; i++) n = n * 256 + buf[i]!;
  return min + (n % range);
};

const HEX = '0123456789abcdef';

export const randomUUID = (): string => {
  const b = new Uint8Array(16);
  getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = (i: number): string => HEX[(b[i]! >> 4) & 0xf]! + HEX[b[i]! & 0xf]!;
  return (
    hex(0) + hex(1) + hex(2) + hex(3) + '-' +
    hex(4) + hex(5) + '-' +
    hex(6) + hex(7) + '-' +
    hex(8) + hex(9) + '-' +
    hex(10) + hex(11) + hex(12) + hex(13) + hex(14) + hex(15)
  );
};

// ---- timingSafeEqual ----

export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) {
    throw codes.ERR_CRYPTO_TIMING_SAFE_EQUAL_LENGTH!();
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
};

// ---- pure-JS MD5 ----

const md5Bytes = (data: Uint8Array): Uint8Array => {
  const r = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
             5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
             4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
             6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  const k: number[] = [];
  for (let i = 0; i < 64; i++) k.push(Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0);

  const ml = data.length * 8;
  const withLen = new Uint8Array(((data.length + 9 + 63) >>> 6) << 6);
  withLen.set(data);
  withLen[data.length] = 0x80;
  for (let i = 0; i < 4; i++) withLen[withLen.length - 8 + i] = (ml >>> (i * 8)) & 0xff;

  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;

  for (let off = 0; off < withLen.length; off += 64) {
    const M: number[] = [];
    for (let i = 0; i < 16; i++) M.push((withLen[off + i * 4]! | (withLen[off + i * 4 + 1]! << 8) | (withLen[off + i * 4 + 2]! << 16) | (withLen[off + i * 4 + 3]! << 24)) >>> 0);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F = 0, g = 0;
      if (i < 16) { F = (B & C) | ((~B) & D); g = i; }
      else if (i < 32) { F = (D & B) | ((~D) & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | (~D)); g = (7 * i) % 16; }
      F = (F + A + k[i]! + M[g]!) >>> 0;
      A = D;
      D = C;
      C = B;
      const shift = r[i]!;
      B = (B + (((F << shift) | (F >>> (32 - shift))) >>> 0)) >>> 0;
    }
    a0 = (a0 + A) >>> 0;
    b0 = (b0 + B) >>> 0;
    c0 = (c0 + C) >>> 0;
    d0 = (d0 + D) >>> 0;
  }

  const out = new Uint8Array(16);
  const write = (n: number, off: number): void => {
    out[off] = n & 0xff;
    out[off + 1] = (n >>> 8) & 0xff;
    out[off + 2] = (n >>> 16) & 0xff;
    out[off + 3] = (n >>> 24) & 0xff;
  };
  write(a0, 0); write(b0, 4); write(c0, 8); write(d0, 12);
  return out;
};

// ---- pure-JS SHA-1 (fallback if host doesn't have it) ----

const rotl32 = (n: number, s: number): number => ((n << s) | (n >>> (32 - s))) >>> 0;

const sha1Bytes = (data: Uint8Array): Uint8Array => {
  const ml = data.length * 8;
  const withLen = new Uint8Array(((data.length + 9 + 63) >>> 6) << 6);
  withLen.set(data);
  withLen[data.length] = 0x80;
  for (let i = 0; i < 4; i++) withLen[withLen.length - 1 - i] = (ml >>> (i * 8)) & 0xff;

  let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;

  for (let off = 0; off < withLen.length; off += 64) {
    const W: number[] = new Array(80);
    for (let i = 0; i < 16; i++) {
      W[i] = (withLen[off + i * 4]! << 24) | (withLen[off + i * 4 + 1]! << 16) | (withLen[off + i * 4 + 2]! << 8) | withLen[off + i * 4 + 3]!;
      W[i] = W[i]! >>> 0;
    }
    for (let i = 16; i < 80; i++) W[i] = rotl32(W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!, 1);
    let a = h0, b = h1, c = h2, d = h3, e = h4;
    for (let i = 0; i < 80; i++) {
      let f = 0, k = 0;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl32(a, 5) + f + e + k + W[i]!) >>> 0;
      e = d; d = c; c = rotl32(b, 30); b = a; a = t;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const writeBE = (n: number, off: number): void => {
    out[off] = (n >>> 24) & 0xff;
    out[off + 1] = (n >>> 16) & 0xff;
    out[off + 2] = (n >>> 8) & 0xff;
    out[off + 3] = n & 0xff;
  };
  writeBE(h0, 0); writeBE(h1, 4); writeBE(h2, 8); writeBE(h3, 12); writeBE(h4, 16);
  return out;
};

// ---- SubtleCrypto-routed sha256/sha384/sha512 ----

const isSubtleCryptoAvailable = (): boolean => {
  return typeof crypto !== 'undefined' && typeof crypto.subtle !== 'undefined' && typeof crypto.subtle.digest === 'function';
};

const SUBTLE_ALG: Record<string, string> = {
  'sha-1': 'SHA-1', sha1: 'SHA-1',
  'sha-256': 'SHA-256', sha256: 'SHA-256',
  'sha-384': 'SHA-384', sha384: 'SHA-384',
  'sha-512': 'SHA-512', sha512: 'SHA-512',
};

const hashSync = (alg: string, data: Uint8Array): Uint8Array => {
  const lower = alg.toLowerCase();
  if (lower === 'md5') return md5Bytes(data);
  if (lower === 'sha1' || lower === 'sha-1') return sha1Bytes(data);

  if (SUBTLE_ALG[lower]) {
    // Subtle is async; we go through the host IPC which can use it synchronously via Atomics.
    const result = __call('crypto.digest', { algorithm: SUBTLE_ALG[lower]!.toLowerCase(), data: Array.from(data) }) as number[] | undefined;
    if (result) return Uint8Array.from(result);
  }

  const e = new TypeError(`Invalid digest: ${alg}`);
  (e as Error & { code?: string }).code = 'ERR_CRYPTO_INVALID_DIGEST';
  throw e;
};

// ---- Hash / Hmac classes ----

export class Hash {
  private _alg: string;
  private _chunks: Uint8Array[] = [];
  private _finalized = false;

  constructor(alg: string) {
    this._alg = alg.toLowerCase();
  }

  update(data: unknown, encoding?: string): this {
    if (this._finalized) {
      const e = new Error('Hash already finalized');
      (e as Error & { code?: string }).code = 'ERR_CRYPTO_HASH_FINALIZED';
      throw e;
    }
    this._chunks.push(toBytes(data, encoding));
    return this;
  }

  digest(encoding?: string): Uint8Array | string {
    this._finalized = true;
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const concat = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { concat.set(c, off); off += c.length; }
    const out = hashSync(this._alg, concat);
    if (!encoding) return bytesToBuffer(out);
    return encodeBytes(out, encoding);
  }

  copy(): Hash {
    const h = new Hash(this._alg);
    h._chunks = this._chunks.slice();
    return h;
  }
}

export class Hmac {
  private _alg: string;
  private _key: Uint8Array;
  private _chunks: Uint8Array[] = [];
  private _finalized = false;

  constructor(alg: string, key: unknown) {
    this._alg = alg.toLowerCase();
    this._key = toBytes(key);
  }

  update(data: unknown, encoding?: string): this {
    if (this._finalized) {
      const e = new Error('Hmac already finalized');
      (e as Error & { code?: string }).code = 'ERR_CRYPTO_HMAC_FINALIZED';
      throw e;
    }
    this._chunks.push(toBytes(data, encoding));
    return this;
  }

  digest(encoding?: string): Uint8Array | string {
    this._finalized = true;
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const concat = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { concat.set(c, off); off += c.length; }

    let result: Uint8Array;
    if (this._alg === 'md5' || this._alg === 'sha1' || this._alg === 'sha-1') {
      result = hmacPureJS(this._alg, this._key, concat);
    } else {
      const alg = (SUBTLE_ALG[this._alg] ?? `SHA-256`).toLowerCase();
      const arr = __call('crypto.hmac', { algorithm: alg, key: Array.from(this._key), data: Array.from(concat) }) as number[] | undefined;
      result = arr ? Uint8Array.from(arr) : hmacPureJS('sha256', this._key, concat);
    }
    if (!encoding) return bytesToBuffer(result);
    return encodeBytes(result, encoding);
  }
}

const hmacBlockSize = (alg: string): number => {
  const a = alg.toLowerCase();
  if (a === 'sha384' || a === 'sha-384' || a === 'sha512' || a === 'sha-512') return 128;
  return 64;
};

const hmacPureJS = (alg: string, key: Uint8Array, data: Uint8Array): Uint8Array => {
  const bs = hmacBlockSize(alg);
  let k = key;
  if (k.length > bs) k = hashSync(alg, k);
  if (k.length < bs) {
    const padded = new Uint8Array(bs);
    padded.set(k);
    k = padded;
  }
  const ipad = new Uint8Array(bs);
  const opad = new Uint8Array(bs);
  for (let i = 0; i < bs; i++) {
    ipad[i] = k[i]! ^ 0x36;
    opad[i] = k[i]! ^ 0x5c;
  }
  const inner = new Uint8Array(bs + data.length);
  inner.set(ipad); inner.set(data, bs);
  const innerHash = hashSync(alg, inner);
  const outer = new Uint8Array(bs + innerHash.length);
  outer.set(opad); outer.set(innerHash, bs);
  return hashSync(alg, outer);
};

const encodeBytes = (bytes: Uint8Array, encoding: string): string => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(enc: string): string } };
  if (Buffer) return Buffer.from(bytes).toString(encoding);
  if (encoding === 'hex') {
    let s = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      s += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
    }
    return s;
  }
  throw codes.ERR_UNKNOWN_ENCODING!(encoding);
};

export const createHash = (alg: string, _opts?: unknown): Hash => new Hash(alg);
export const createHmac = (alg: string, key: unknown, _opts?: unknown): Hmac => new Hmac(alg, key);

// ---- pbkdf2 (via host SubtleCrypto.deriveBits) ----

export const pbkdf2Sync = (password: unknown, salt: unknown, iterations: number, keylen: number, digest: string): Uint8Array => {
  const p = toBytes(password);
  const s = toBytes(salt);
  const subtleAlg = SUBTLE_ALG[digest.toLowerCase()] ?? 'SHA-256';
  const arr = __call('crypto.pbkdf2', {
    password: Array.from(p),
    salt: Array.from(s),
    iterations,
    keylen,
    digest: subtleAlg,
  }) as number[] | undefined;
  if (!arr) {
    throw codes.ERR_CRYPTO_UNSUPPORTED_OPERATION!('pbkdf2');
  }
  return bytesToBuffer(Uint8Array.from(arr));
};

export const pbkdf2 = (
  password: unknown, salt: unknown, iterations: number, keylen: number, digest: string,
  cb: (err: Error | null, derivedKey?: Uint8Array) => void,
): void => {
  Promise.resolve().then(() => {
    try { cb(null, pbkdf2Sync(password, salt, iterations, keylen, digest)); }
    catch (e) { cb(e as Error); }
  });
};

// ---- Cipher / Decipher ----
//
// Routes through host SubtleCrypto for AES-CBC and AES-GCM. AES-CTR also via subtle.
// For GCM, authTag is appended to ciphertext and stripped in decrypt.

const SUBTLE_CIPHER_MAP: Record<string, { name: string; tagLength?: number }> = {
  'aes-128-cbc': { name: 'AES-CBC' },
  'aes-192-cbc': { name: 'AES-CBC' },
  'aes-256-cbc': { name: 'AES-CBC' },
  'aes-128-gcm': { name: 'AES-GCM', tagLength: 16 },
  'aes-192-gcm': { name: 'AES-GCM', tagLength: 16 },
  'aes-256-gcm': { name: 'AES-GCM', tagLength: 16 },
  'aes-128-ctr': { name: 'AES-CTR' },
  'aes-192-ctr': { name: 'AES-CTR' },
  'aes-256-ctr': { name: 'AES-CTR' },
};

export class Cipher {
  private _alg: string;
  private _key: Uint8Array;
  private _iv: Uint8Array;
  private _chunks: Uint8Array[] = [];
  private _authTag: Uint8Array | null = null;
  private _aad: Uint8Array | null = null;
  private _finalized = false;

  constructor(alg: string, key: unknown, iv: unknown) {
    this._alg = alg.toLowerCase();
    this._key = toBytes(key);
    this._iv = toBytes(iv);
  }

  setAAD(buf: unknown): this {
    this._aad = toBytes(buf);
    return this;
  }

  update(data: unknown, _inputEncoding?: string, _outputEncoding?: string): Uint8Array | string {
    if (this._finalized) throw codes.ERR_CRYPTO_INVALID_STATE!('Cipher already finalized');
    this._chunks.push(toBytes(data));
    return new Uint8Array(0);  // We buffer; full encrypt happens in final()
  }

  final(_outputEncoding?: string): Uint8Array | string {
    this._finalized = true;
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const plaintext = new Uint8Array(totalLen);
    let off = 0;
    for (const c of this._chunks) { plaintext.set(c, off); off += c.length; }

    const subtleAlg = SUBTLE_CIPHER_MAP[this._alg];
    if (!subtleAlg) {
      throw codes.ERR_CRYPTO_UNKNOWN_CIPHER!(this._alg);
    }

    const result = __call('crypto.encrypt', {
      algorithm: this._alg,
      key: Array.from(this._key),
      iv: Array.from(this._iv),
      plaintext: Array.from(plaintext),
      ...(this._aad ? { aad: Array.from(this._aad) } : {}),
    }) as { ciphertext: number[]; authTag?: number[] } | undefined;

    if (!result) throw codes.ERR_OPERATION_FAILED!('cipher.final');
    const cipherBytes = Uint8Array.from(result.ciphertext);
    if (result.authTag) this._authTag = Uint8Array.from(result.authTag);
    return bytesToBuffer(cipherBytes);
  }

  getAuthTag(): Uint8Array {
    if (!this._authTag) throw codes.ERR_CRYPTO_INVALID_STATE!('getAuthTag: no auth tag set');
    return bytesToBuffer(this._authTag);
  }
}

export class Decipher {
  private _alg: string;
  private _key: Uint8Array;
  private _iv: Uint8Array;
  private _chunks: Uint8Array[] = [];
  private _authTag: Uint8Array | null = null;
  private _aad: Uint8Array | null = null;
  private _finalized = false;

  constructor(alg: string, key: unknown, iv: unknown) {
    this._alg = alg.toLowerCase();
    this._key = toBytes(key);
    this._iv = toBytes(iv);
  }

  setAuthTag(tag: unknown): this {
    this._authTag = toBytes(tag);
    return this;
  }

  setAAD(buf: unknown): this {
    this._aad = toBytes(buf);
    return this;
  }

  update(data: unknown, _inputEncoding?: string, _outputEncoding?: string): Uint8Array | string {
    if (this._finalized) throw codes.ERR_CRYPTO_INVALID_STATE!('Decipher already finalized');
    this._chunks.push(toBytes(data));
    return new Uint8Array(0);
  }

  final(_outputEncoding?: string): Uint8Array | string {
    this._finalized = true;
    let totalLen = 0;
    for (const c of this._chunks) totalLen += c.length;
    const ciphertext = new Uint8Array(totalLen);
    let off = 0;
    for (const c of this._chunks) { ciphertext.set(c, off); off += c.length; }

    const subtleAlg = SUBTLE_CIPHER_MAP[this._alg];
    if (!subtleAlg) {
      throw codes.ERR_CRYPTO_UNKNOWN_CIPHER!(this._alg);
    }

    const result = __call('crypto.decrypt', {
      algorithm: this._alg,
      key: Array.from(this._key),
      iv: Array.from(this._iv),
      ciphertext: Array.from(ciphertext),
      ...(this._authTag ? { authTag: Array.from(this._authTag) } : {}),
      ...(this._aad ? { aad: Array.from(this._aad) } : {}),
    }) as { plaintext: number[] } | undefined;

    if (!result) throw codes.ERR_OPERATION_FAILED!('decipher.final');
    return bytesToBuffer(Uint8Array.from(result.plaintext));
  }
}

export const createCipheriv = (alg: string, key: unknown, iv: unknown, _opts?: unknown): Cipher => {
  return new Cipher(alg, key, iv);
};

export const createDecipheriv = (alg: string, key: unknown, iv: unknown, _opts?: unknown): Decipher => {
  return new Decipher(alg, key, iv);
};

// ---- scrypt (pure-JS slow; only acceptable for very small N) ----
// We provide a basic implementation; for production use users should pick another lib.

export const scryptSync = (
  password: unknown, salt: unknown, keylen: number,
  _opts?: { N?: number; r?: number; p?: number; maxmem?: number },
): Uint8Array => {
  // Fall back to PBKDF2 with high iterations as a stand-in.
  // This is NOT real scrypt; documented as such.
  return pbkdf2Sync(password, salt, 100000, keylen, 'sha256');
};

export const scrypt = (
  password: unknown, salt: unknown, keylen: number,
  optsOrCb: unknown, maybeCb?: Function,
): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as (e: Error | null, key?: Uint8Array) => void;
  if (!cb) throw codes.ERR_INVALID_CALLBACK!(cb);
  Promise.resolve().then(() => {
    try { cb(null, scryptSync(password, salt, keylen)); }
    catch (e) { cb(e as Error); }
  });
};

// ---- Asymmetric crypto (sign/verify/generateKeyPair) ----
//
// Backed by SubtleCrypto via host IPC. Supports RSA-PKCS1, RSA-PSS, and ECDSA.
// Keys may be supplied as Node-style KeyObjects (any object with a `key` field),
// raw DER bytes (Uint8Array), or PEM strings.

interface KeyMaterial {
  bytes: Uint8Array;
  keyType: 'rsa' | 'rsa-pss' | 'ec';
  format: 'spki' | 'pkcs8';
}

const base64DecodeToBytes = (s: string): Uint8Array => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(s: string, e?: string): Uint8Array };
  if (Buffer) return Buffer.from(s, 'base64');
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

const stripPem = (pem: string): { type: string; body: Uint8Array } | null => {
  const m = /-----BEGIN (.+?)-----([\s\S]+?)-----END \1-----/.exec(pem);
  if (!m) return null;
  const body = base64DecodeToBytes(m[2]!.replace(/\s+/g, ''));
  return { type: m[1]!, body };
};

const inferKeyTypeFromAlgorithm = (algorithm: string): 'rsa' | 'rsa-pss' | 'ec' => {
  const a = algorithm.toLowerCase();
  if (a.includes('rsa-pss') || a.includes('rsapss')) return 'rsa-pss';
  if (a.includes('ecdsa') || a.startsWith('ec-')) return 'ec';
  return 'rsa';
};

const inferHashFromAlgorithm = (algorithm: string): string => {
  const a = algorithm.toLowerCase();
  if (a.includes('sha512') || a.includes('sha-512')) return 'SHA-512';
  if (a.includes('sha384') || a.includes('sha-384')) return 'SHA-384';
  if (a.includes('sha224') || a.includes('sha-224')) return 'SHA-224';
  if (a.includes('sha1') || a.includes('sha-1')) return 'SHA-1';
  if (a.includes('md5')) return 'SHA-256'; // SubtleCrypto can't md5; substitute
  return 'SHA-256';
};

const extractKeyMaterial = (key: unknown, expectPrivate: boolean): KeyMaterial => {
  // KeyObject-like: { key, type, format }
  if (key && typeof key === 'object') {
    const k = key as { key?: unknown; type?: string; format?: string };
    if (k.key !== undefined) {
      const inner = extractKeyMaterial(k.key, expectPrivate);
      return inner;
    }
  }
  let raw: Uint8Array;
  let pemType: string | null = null;
  if (typeof key === 'string') {
    const p = stripPem(key);
    if (p) {
      raw = p.body;
      pemType = p.type;
    } else {
      // Treat as base64
      raw = base64DecodeToBytes(key);
    }
  } else if (key instanceof Uint8Array) {
    raw = key;
  } else if (Array.isArray(key)) {
    raw = Uint8Array.from(key as number[]);
  } else if (ArrayBuffer.isView(key)) {
    raw = new Uint8Array((key as ArrayBufferView).buffer, (key as ArrayBufferView).byteOffset, (key as ArrayBufferView).byteLength);
  } else {
    throw codes.ERR_INVALID_ARG_TYPE!('key', ['string', 'Buffer', 'KeyObject'], key);
  }

  // Infer DER format from PEM headers when available
  let format: 'spki' | 'pkcs8';
  let keyType: 'rsa' | 'rsa-pss' | 'ec' = 'rsa';
  if (pemType) {
    const t = pemType.toUpperCase();
    if (t.includes('PRIVATE')) format = 'pkcs8';
    else format = 'spki';
    if (t.includes('EC') || t.includes('ECDSA')) keyType = 'ec';
    else if (t.includes('RSA-PSS') || t.includes('PSS')) keyType = 'rsa-pss';
    else keyType = 'rsa';
  } else {
    format = expectPrivate ? 'pkcs8' : 'spki';
    // Caller will override keyType based on algorithm
  }
  return { bytes: raw, keyType, format };
};

export class Sign {
  private _alg: string;
  private _chunks: Uint8Array[] = [];

  constructor(alg: string) {
    this._alg = alg;
  }

  update(data: unknown, enc?: string): this {
    this._chunks.push(toBytes(data, enc ?? 'utf8'));
    return this;
  }

  sign(key: unknown, outputEncoding?: string): Uint8Array | string {
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { data.set(c, off); off += c.length; }
    const km = extractKeyMaterial(key, true);
    const inferredType = inferKeyTypeFromAlgorithm(this._alg);
    const keyType = km.keyType !== 'rsa' ? km.keyType : inferredType;
    const hash = inferHashFromAlgorithm(this._alg);
    const sig = __call('crypto.sign', {
      algorithm: this._alg,
      key: Array.from(km.bytes),
      data: Array.from(data),
      keyType,
      hash,
    }) as number[];
    const out = Uint8Array.from(sig);
    if (outputEncoding) {
      const g = globalThis as Record<string, unknown>;
      const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(e: string): string } };
      if (Buffer) return Buffer.from(out).toString(outputEncoding);
    }
    return bytesToBuffer(out);
  }
}

export class Verify {
  private _alg: string;
  private _chunks: Uint8Array[] = [];

  constructor(alg: string) {
    this._alg = alg;
  }

  update(data: unknown, enc?: string): this {
    this._chunks.push(toBytes(data, enc ?? 'utf8'));
    return this;
  }

  verify(key: unknown, signature: unknown, sigEncoding?: string): boolean {
    let total = 0;
    for (const c of this._chunks) total += c.length;
    const data = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { data.set(c, off); off += c.length; }
    const sigBytes = toBytes(signature, sigEncoding ?? 'utf8');
    const km = extractKeyMaterial(key, false);
    const inferredType = inferKeyTypeFromAlgorithm(this._alg);
    const keyType = km.keyType !== 'rsa' ? km.keyType : inferredType;
    const hash = inferHashFromAlgorithm(this._alg);
    return __call('crypto.verify', {
      key: Array.from(km.bytes),
      data: Array.from(data),
      signature: Array.from(sigBytes),
      keyType,
      hash,
    }) as boolean;
  }
}

export const createSign = (alg: string): Sign => new Sign(alg);
export const createVerify = (alg: string): Verify => new Verify(alg);

// ---- generateKeyPair ----

export interface GenerateKeyPairOptions {
  modulusLength?: number;
  publicExponent?: number;
  namedCurve?: string;
  hash?: string;
  publicKeyEncoding?: { type?: string; format?: 'pem' | 'der' };
  privateKeyEncoding?: { type?: string; format?: 'pem' | 'der' };
}

const wrapPem = (header: string, der: Uint8Array): string => {
  const g = globalThis as Record<string, unknown>;
  const Buffer = g['Buffer'] as undefined | { from(b: Uint8Array): { toString(e: string): string } };
  let b64: string;
  if (Buffer) b64 = Buffer.from(der).toString('base64');
  else {
    let s = '';
    for (let i = 0; i < der.length; i++) s += String.fromCharCode(der[i]!);
    b64 = btoa(s);
  }
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 64) lines.push(b64.slice(i, i + 64));
  return `-----BEGIN ${header}-----\n${lines.join('\n')}\n-----END ${header}-----\n`;
};

const encodeKey = (kind: 'public' | 'private', der: Uint8Array, encoding: { type?: string; format?: 'pem' | 'der' } | undefined): Uint8Array | string => {
  if (!encoding || encoding.format === 'der') return bytesToBuffer(der);
  if (encoding.format === 'pem') {
    const header = kind === 'public' ? 'PUBLIC KEY' : 'PRIVATE KEY';
    return wrapPem(header, der);
  }
  return bytesToBuffer(der);
};

export const generateKeyPairSync = (
  type: 'rsa' | 'rsa-pss' | 'ec' | 'ecdsa',
  options: GenerateKeyPairOptions = {},
): { publicKey: Uint8Array | string; privateKey: Uint8Array | string } => {
  const r = __call('crypto.generateKeyPair', {
    type,
    modulusLength: options.modulusLength,
    namedCurve: options.namedCurve,
    hash: options.hash,
  }) as { publicKey: number[]; privateKey: number[] };
  const pubDer = Uint8Array.from(r.publicKey);
  const privDer = Uint8Array.from(r.privateKey);
  return {
    publicKey: encodeKey('public', pubDer, options.publicKeyEncoding),
    privateKey: encodeKey('private', privDer, options.privateKeyEncoding),
  };
};

export const generateKeyPair = (
  type: 'rsa' | 'rsa-pss' | 'ec' | 'ecdsa',
  optsOrCb: GenerateKeyPairOptions | Function,
  maybeCb?: Function,
): void => {
  const cb = (typeof optsOrCb === 'function' ? optsOrCb : maybeCb) as
    | ((e: Error | null, publicKey?: Uint8Array | string, privateKey?: Uint8Array | string) => void)
    | undefined;
  const options = (typeof optsOrCb === 'object' && optsOrCb !== null ? optsOrCb as GenerateKeyPairOptions : {});
  if (!cb) throw codes.ERR_INVALID_CALLBACK!(cb);
  Promise.resolve().then(() => {
    try {
      const kp = generateKeyPairSync(type, options);
      cb(null, kp.publicKey, kp.privateKey);
    } catch (e) {
      cb(e as Error);
    }
  });
};

// ---- getCiphers / getHashes (informational) ----

export const getHashes = (): string[] => ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
export const getCiphers = (): string[] => ['aes-128-cbc', 'aes-256-cbc', 'aes-128-gcm', 'aes-256-gcm'];

// ---- webcrypto passthrough ----

export const webcrypto = (typeof crypto !== 'undefined' ? crypto : undefined);

export const constants = Object.freeze({});

export const nodeCrypto = {
  randomBytes,
  randomFill,
  randomFillSync,
  randomInt,
  randomUUID,
  timingSafeEqual,
  Hash,
  Hmac,
  createHash,
  createHmac,
  pbkdf2,
  pbkdf2Sync,
  scrypt,
  scryptSync,
  Cipher,
  Decipher,
  createCipheriv,
  createDecipheriv,
  Sign,
  Verify,
  createSign,
  createVerify,
  generateKeyPair,
  generateKeyPairSync,
  getHashes,
  getCiphers,
  webcrypto,
  constants,
};
