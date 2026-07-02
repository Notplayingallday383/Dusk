// Minimal HTTP/1.1 parser. State machine over an internal byte buffer.
//
// API:
//   const p = new HttpParser('REQUEST' | 'RESPONSE');
//   p.onHeadersComplete = (info) => ...;
//   p.onBody = (chunk: Uint8Array) => ...;
//   p.onMessageComplete = () => ...;
//   p.execute(bytes);
//   p.finish();

export interface HttpHeadersInfo {
  versionMajor: number;
  versionMinor: number;
  headers: string[];                       // [name1, value1, name2, value2, ...]
  method?: string;                         // request only
  url?: string;                            // request only
  statusCode?: number;                     // response only
  statusMessage?: string;                  // response only
  upgrade: boolean;
  shouldKeepAlive: boolean;
}

const enum S {
  START,
  HEADERS,
  BODY_LENGTH,
  BODY_CHUNKED_SIZE,
  BODY_CHUNKED_DATA,
  BODY_CHUNKED_END,
  BODY_UNTIL_EOF,
  DONE,
  ERROR,
}

const CR = 13;
const LF = 10;

const decodeAscii = (bytes: Uint8Array, start: number, end: number): string => {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

export class HttpParser {
  type: 'REQUEST' | 'RESPONSE';
  onHeadersComplete?: (info: HttpHeadersInfo) => number | void;
  onBody?: (chunk: Uint8Array) => void;
  onMessageComplete?: () => void;
  onError?: (err: Error) => void;

  private buf: Uint8Array = new Uint8Array(0);
  private state: S = S.START;
  private contentLength = -1;
  private chunkRemaining = 0;
  private chunked = false;
  private upgrade = false;
  private shouldKeepAlive = true;
  private currentHeaders: HttpHeadersInfo = {
    versionMajor: 1, versionMinor: 1, headers: [],
    upgrade: false, shouldKeepAlive: true,
  };

  constructor(type: 'REQUEST' | 'RESPONSE') {
    this.type = type;
  }

  execute(input: Uint8Array): number {
    if (input.length === 0) return 0;
    const combined = new Uint8Array(this.buf.length + input.length);
    combined.set(this.buf);
    combined.set(input, this.buf.length);
    this.buf = combined;

    let cursor = 0;
    while (cursor < this.buf.length) {
      if (this.state === S.START || this.state === S.HEADERS) {
        const headerEnd = findHeaderEnd(this.buf, cursor);
        if (headerEnd < 0) break;
        const headerBytes = this.buf.subarray(cursor, headerEnd);
        if (!this._parseHead(headerBytes)) {
          this.state = S.ERROR;
          if (this.onError) this.onError(new Error('Invalid HTTP head'));
          return cursor;
        }
        const ret = this.onHeadersComplete ? this.onHeadersComplete(this.currentHeaders) : undefined;
        cursor = headerEnd + 4; // skip \r\n\r\n
        if (this.upgrade || ret === 2) {
          this.state = S.DONE;
          if (this.onMessageComplete) this.onMessageComplete();
          break;
        }
        if (this.chunked) this.state = S.BODY_CHUNKED_SIZE;
        else if (this.contentLength === 0) {
          this.state = S.DONE;
          if (this.onMessageComplete) this.onMessageComplete();
          break;
        }
        else if (this.contentLength > 0) this.state = S.BODY_LENGTH;
        else if (this.type === 'RESPONSE') this.state = S.BODY_UNTIL_EOF;
        else { this.state = S.DONE; if (this.onMessageComplete) this.onMessageComplete(); break; }
      } else if (this.state === S.BODY_LENGTH) {
        const avail = this.buf.length - cursor;
        const want = Math.min(avail, this.contentLength);
        if (want > 0 && this.onBody) this.onBody(this.buf.subarray(cursor, cursor + want));
        cursor += want;
        this.contentLength -= want;
        if (this.contentLength <= 0) {
          this.state = S.DONE;
          if (this.onMessageComplete) this.onMessageComplete();
          break;
        }
        break;
      } else if (this.state === S.BODY_CHUNKED_SIZE) {
        const eol = findCRLF(this.buf, cursor);
        if (eol < 0) break;
        const line = decodeAscii(this.buf, cursor, eol);
        const sizeStr = line.split(';')[0]!.trim();
        const size = parseInt(sizeStr, 16);
        if (isNaN(size)) {
          this.state = S.ERROR;
          if (this.onError) this.onError(new Error('Invalid chunk size'));
          return cursor;
        }
        cursor = eol + 2;
        if (size === 0) {
          this.state = S.BODY_CHUNKED_END;
        } else {
          this.chunkRemaining = size;
          this.state = S.BODY_CHUNKED_DATA;
        }
      } else if (this.state === S.BODY_CHUNKED_DATA) {
        const avail = this.buf.length - cursor;
        const want = Math.min(avail, this.chunkRemaining);
        if (want > 0 && this.onBody) this.onBody(this.buf.subarray(cursor, cursor + want));
        cursor += want;
        this.chunkRemaining -= want;
        if (this.chunkRemaining === 0) {
          if (cursor + 2 > this.buf.length) break;
          cursor += 2; // skip trailing \r\n
          this.state = S.BODY_CHUNKED_SIZE;
        } else break;
      } else if (this.state === S.BODY_CHUNKED_END) {
        const eol = findCRLF(this.buf, cursor);
        if (eol < 0) break;
        cursor = eol + 2;
        this.state = S.DONE;
        if (this.onMessageComplete) this.onMessageComplete();
        break;
      } else if (this.state === S.BODY_UNTIL_EOF) {
        const avail = this.buf.length - cursor;
        if (avail > 0 && this.onBody) this.onBody(this.buf.subarray(cursor));
        cursor = this.buf.length;
        break;
      } else {
        break;
      }
    }

    this.buf = this.buf.subarray(cursor);
    return input.length;
  }

  finish(): void {
    if (this.state === S.BODY_UNTIL_EOF) {
      this.state = S.DONE;
      if (this.onMessageComplete) this.onMessageComplete();
    }
  }

  private _parseHead(bytes: Uint8Array): boolean {
    const text = decodeAscii(bytes, 0, bytes.length);
    const lines = text.split('\r\n');
    if (lines.length === 0) return false;
    const firstLine = lines[0]!;

    this.currentHeaders = {
      versionMajor: 1, versionMinor: 1, headers: [],
      upgrade: false, shouldKeepAlive: true,
    };
    this.contentLength = -1;
    this.chunked = false;
    this.upgrade = false;
    this.shouldKeepAlive = true;

    if (this.type === 'REQUEST') {
      const parts = firstLine.split(' ');
      if (parts.length < 3) return false;
      this.currentHeaders.method = parts[0]!;
      this.currentHeaders.url = parts[1]!;
      const vmatch = /^HTTP\/(\d)\.(\d)$/.exec(parts[2]!);
      if (!vmatch) return false;
      this.currentHeaders.versionMajor = parseInt(vmatch[1]!, 10);
      this.currentHeaders.versionMinor = parseInt(vmatch[2]!, 10);
    } else {
      const m = /^HTTP\/(\d)\.(\d)\s+(\d{3})\s*(.*)$/.exec(firstLine);
      if (!m) return false;
      this.currentHeaders.versionMajor = parseInt(m[1]!, 10);
      this.currentHeaders.versionMinor = parseInt(m[2]!, 10);
      this.currentHeaders.statusCode = parseInt(m[3]!, 10);
      this.currentHeaders.statusMessage = m[4]!;
    }

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line) continue;
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const name = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      const lname = name.toLowerCase();
      this.currentHeaders.headers.push(name, value);
      if (lname === 'content-length') {
        this.contentLength = parseInt(value, 10);
        if (isNaN(this.contentLength) || this.contentLength < 0) this.contentLength = -1;
      } else if (lname === 'transfer-encoding' && /chunked/i.test(value)) {
        this.chunked = true;
      } else if (lname === 'connection') {
        if (/close/i.test(value)) this.shouldKeepAlive = false;
        if (/upgrade/i.test(value)) this.upgrade = true;
      } else if (lname === 'upgrade') {
        this.upgrade = true;
      }
    }
    if (this.currentHeaders.versionMajor === 1 && this.currentHeaders.versionMinor === 0) {
      this.shouldKeepAlive = false;
    }
    this.currentHeaders.upgrade = this.upgrade;
    this.currentHeaders.shouldKeepAlive = this.shouldKeepAlive;
    return true;
  }
}

const findHeaderEnd = (buf: Uint8Array, start: number): number => {
  for (let i = start; i + 3 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF && buf[i + 2] === CR && buf[i + 3] === LF) return i;
  }
  return -1;
};

const findCRLF = (buf: Uint8Array, start: number): number => {
  for (let i = start; i + 1 < buf.length; i++) {
    if (buf[i] === CR && buf[i + 1] === LF) return i;
  }
  return -1;
};
