// node:readline — line-by-line input over a Readable.

import { EventEmitter } from './node-events';
import { Readable, Writable } from './node-stream';

export interface ReadlineInterfaceOptions {
  input: Readable | { on(event: string, listener: Function): unknown; pause?: () => unknown; resume?: () => unknown };
  output?: Writable | { write(data: string): unknown };
  completer?: (line: string) => [string[], string];
  terminal?: boolean;
  history?: string[];
  historySize?: number;
  removeHistoryDuplicates?: boolean;
  prompt?: string;
  crlfDelay?: number;
  escapeCodeTimeout?: number;
  tabSize?: number;
}

export class Interface extends EventEmitter {
  readonly terminal: boolean;
  history: string[];
  private input: ReadlineInterfaceOptions['input'];
  private output: ReadlineInterfaceOptions['output'] | undefined;
  private _buffer = '';
  private _prompt: string;
  private _closed = false;
  private _historySize: number;

  constructor(opts: ReadlineInterfaceOptions) {
    super();
    this.input = opts.input;
    if (opts.output) this.output = opts.output;
    this.terminal = !!opts.terminal;
    this.history = opts.history ? opts.history.slice() : [];
    this._historySize = opts.historySize ?? 30;
    this._prompt = opts.prompt ?? '> ';
    this._wire();
  }

  private _wire(): void {
    const onData = (chunk: unknown): void => {
      if (this._closed) return;
      let s = '';
      if (typeof chunk === 'string') s = chunk;
      else if (chunk instanceof Uint8Array) {
        for (let i = 0; i < chunk.length; i++) s += String.fromCharCode(chunk[i]!);
      }
      this._buffer += s;
      this._extractLines();
    };
    const onEnd = (): void => {
      if (this._buffer.length > 0) {
        const last = this._buffer;
        this._buffer = '';
        this._handleLine(last);
      }
      this.emit('close');
      this._closed = true;
    };
    (this.input as { on(e: string, l: Function): unknown }).on('data', onData);
    (this.input as { on(e: string, l: Function): unknown }).on('end', onEnd);
  }

  private _extractLines(): void {
    let idx: number;
    while ((idx = this._buffer.indexOf('\n')) >= 0) {
      let line = this._buffer.slice(0, idx);
      this._buffer = this._buffer.slice(idx + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this._handleLine(line);
    }
  }

  private _handleLine(line: string): void {
    if (this.history.length === 0 || this.history[0] !== line) {
      this.history.unshift(line);
      if (this.history.length > this._historySize) this.history.length = this._historySize;
    }
    this.emit('line', line);
  }

  setPrompt(prompt: string): void {
    this._prompt = prompt;
  }

  getPrompt(): string {
    return this._prompt;
  }

  prompt(preserveCursor?: boolean): void {
    if (this._closed) return;
    if (this.output) this.output.write(this._prompt);
  }

  question(query: string, cb: (answer: string) => void): void;
  question(query: string, opts: { signal?: AbortSignal }, cb: (answer: string) => void): void;
  question(query: string, optsOrCb: unknown, maybeCb?: (answer: string) => void): void {
    const cb = typeof optsOrCb === 'function' ? (optsOrCb as (a: string) => void) : maybeCb;
    if (!cb) throw new TypeError('callback required');
    if (this.output) this.output.write(query);
    this.once('line', cb as (...args: unknown[]) => void);
  }

  pause(): this {
    const i = this.input as { pause?: () => unknown };
    if (i.pause) i.pause();
    return this;
  }

  resume(): this {
    const i = this.input as { resume?: () => unknown };
    if (i.resume) i.resume();
    return this;
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.emit('close');
  }

  write(_data: string, _key?: unknown): void {
    // Best-effort no-op for the non-terminal case
  }

  getCursorPos(): { rows: number; cols: number } { return { rows: 0, cols: 0 }; }

  [Symbol.asyncIterator](): AsyncIterableIterator<string> {
    const queue: string[] = [];
    const waiters: Array<{ resolve: (v: IteratorResult<string>) => void }> = [];
    let done = false;
    this.on('line', (l) => {
      const line = l as string;
      if (waiters.length) waiters.shift()!.resolve({ value: line, done: false });
      else queue.push(line);
    });
    this.on('close', () => {
      done = true;
      while (waiters.length) waiters.shift()!.resolve({ value: undefined as unknown as string, done: true });
    });
    return {
      [Symbol.asyncIterator](): AsyncIterableIterator<string> { return this; },
      next(): Promise<IteratorResult<string>> {
        if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
        if (done) return Promise.resolve({ value: undefined as unknown as string, done: true });
        return new Promise<IteratorResult<string>>((resolve) => waiters.push({ resolve }));
      },
      return(): Promise<IteratorResult<string>> {
        done = true;
        return Promise.resolve({ value: undefined as unknown as string, done: true });
      },
    };
  }
}

export const createInterface = (opts: ReadlineInterfaceOptions): Interface => new Interface(opts);

// Cursor / line helpers (no-ops without a real terminal)
export const cursorTo = (_stream: unknown, _x: number, _y?: number, _cb?: () => void): boolean => true;
export const moveCursor = (_stream: unknown, _dx: number, _dy: number, _cb?: () => void): boolean => true;
export const clearLine = (_stream: unknown, _dir: number, _cb?: () => void): boolean => true;
export const clearScreenDown = (_stream: unknown, _cb?: () => void): boolean => true;

export const emitKeypressEvents = (_stream: unknown, _iface?: Interface): void => undefined;

const promises = {
  Interface,
  createInterface: (opts: ReadlineInterfaceOptions): Interface => new Interface(opts),
};

export const nodeReadline = {
  Interface,
  createInterface,
  cursorTo,
  moveCursor,
  clearLine,
  clearScreenDown,
  emitKeypressEvents,
  promises,
};
