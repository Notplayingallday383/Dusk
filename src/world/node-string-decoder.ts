// node:string_decoder — incremental UTF-8 / utf16le / base64 / hex / latin1 decoder
// (handles multi-byte sequences split across chunk boundaries)

type Encoding = 'utf8' | 'utf-8' | 'utf16le' | 'utf-16le' | 'ucs2' | 'ucs-2' | 'base64' | 'base64url' | 'latin1' | 'binary' | 'ascii' | 'hex';

const normalizeEncoding = (enc?: string): Encoding => {
  const e = (enc ?? 'utf8').toLowerCase();
  switch (e) {
    case 'utf8': case 'utf-8': return 'utf8';
    case 'utf16le': case 'utf-16le': case 'ucs2': case 'ucs-2': return 'utf16le';
    case 'base64': return 'base64';
    case 'base64url': return 'base64url';
    case 'latin1': case 'binary': return 'latin1';
    case 'ascii': return 'ascii';
    case 'hex': return 'hex';
    default:
      throw new TypeError(`Unknown encoding: ${enc}`);
  }
};

const toU8 = (data: unknown): Uint8Array => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength);
  if (typeof data === 'string') {
    // Encode UTF-8
    const out: number[] = [];
    for (let i = 0; i < data.length; i++) {
      let c = data.charCodeAt(i);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
    return Uint8Array.from(out);
  }
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  return new Uint8Array(0);
};

const HEX = '0123456789abcdef';

export class StringDecoder {
  private encoding: Encoding;
  private buffered: Uint8Array = new Uint8Array(0);

  constructor(encoding?: string) {
    this.encoding = normalizeEncoding(encoding);
  }

  write(data: unknown): string {
    const bytes = toU8(data);
    if (this.buffered.length > 0) {
      const merged = new Uint8Array(this.buffered.length + bytes.length);
      merged.set(this.buffered);
      merged.set(bytes, this.buffered.length);
      this.buffered = merged;
    } else {
      this.buffered = bytes;
    }
    return this._consume(false);
  }

  end(data?: unknown): string {
    let out = data === undefined ? '' : this.write(data);
    out += this._consume(true);
    return out;
  }

  private _consume(final: boolean): string {
    const enc = this.encoding;
    if (enc === 'utf8') {
      let i = 0;
      let s = '';
      while (i < this.buffered.length) {
        const b1 = this.buffered[i]!;
        let need = 0;
        if (b1 < 0x80) need = 1;
        else if (b1 < 0xc0) { s += '\ufffd'; i++; continue; }
        else if (b1 < 0xe0) need = 2;
        else if (b1 < 0xf0) need = 3;
        else need = 4;
        if (i + need > this.buffered.length) {
          if (final) { s += '\ufffd'; break; }
          break;
        }
        if (need === 1) { s += String.fromCharCode(b1); i++; }
        else if (need === 2) { s += String.fromCharCode(((b1 & 0x1f) << 6) | (this.buffered[i + 1]! & 0x3f)); i += 2; }
        else if (need === 3) { s += String.fromCharCode(((b1 & 0x0f) << 12) | ((this.buffered[i + 1]! & 0x3f) << 6) | (this.buffered[i + 2]! & 0x3f)); i += 3; }
        else {
          const cp = ((b1 & 0x07) << 18) | ((this.buffered[i + 1]! & 0x3f) << 12) | ((this.buffered[i + 2]! & 0x3f) << 6) | (this.buffered[i + 3]! & 0x3f);
          const off = cp - 0x10000;
          s += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff));
          i += 4;
        }
      }
      this.buffered = this.buffered.subarray(i);
      return s;
    }
    if (enc === 'utf16le') {
      const usableLen = this.buffered.length & ~1;
      let s = '';
      for (let i = 0; i + 1 < usableLen; i += 2) {
        s += String.fromCharCode(this.buffered[i]! | (this.buffered[i + 1]! << 8));
      }
      this.buffered = this.buffered.subarray(usableLen);
      if (final && this.buffered.length === 1) s += '\ufffd';
      return s;
    }
    if (enc === 'ascii' || enc === 'latin1') {
      let s = '';
      for (let i = 0; i < this.buffered.length; i++) s += String.fromCharCode(this.buffered[i]!);
      this.buffered = new Uint8Array(0);
      return s;
    }
    if (enc === 'hex') {
      let s = '';
      for (let i = 0; i < this.buffered.length; i++) {
        const b = this.buffered[i]!;
        s += HEX[(b >> 4) & 0xf]! + HEX[b & 0xf]!;
      }
      this.buffered = new Uint8Array(0);
      return s;
    }
    if (enc === 'base64' || enc === 'base64url') {
      const usableLen = Math.floor(this.buffered.length / 3) * 3;
      const slice = this.buffered.subarray(0, usableLen);
      this.buffered = this.buffered.subarray(usableLen);
      return base64EncodeUint8(slice, enc === 'base64url');
    }
    return '';
  }
}

const base64EncodeUint8 = (bytes: Uint8Array, urlSafe: boolean): string => {
  const alphabet = urlSafe
    ? 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    : 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let s = '';
  for (let i = 0; i + 2 < bytes.length; i += 3) {
    const b0 = bytes[i]!, b1 = bytes[i + 1]!, b2 = bytes[i + 2]!;
    s += alphabet[b0 >> 2]! + alphabet[((b0 & 3) << 4) | (b1 >> 4)]! + alphabet[((b1 & 15) << 2) | (b2 >> 6)]! + alphabet[b2 & 63]!;
  }
  return s;
};

export const nodeStringDecoder = {
  StringDecoder,
};
