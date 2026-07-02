// node:repl — interactive Read-Eval-Print Loop server.
//
// API surface:
//   const r = repl.start({ prompt: '> ', input: process.stdin, output: process.stdout });
//   r.on('exit', () => { ... });
//   r.context.foo = 1;            // expose into REPL context
//   r.defineCommand('hi', { help: 'Say hi', action() { ... } });
//
// Internals: line-buffered reader on input stream, evaluator that supports both
// expressions and statements, with persistent declarations (let/const/var bound
// onto the context object so subsequent lines can see them).

import { EventEmitter } from './node-events';

interface ReplOptions {
  prompt?: string;
  input?: { on(event: 'data', cb: (data: unknown) => void): unknown; resume?(): unknown; setEncoding?(enc: string): unknown };
  output?: { write(data: string | Uint8Array): unknown };
  useColors?: boolean;
  terminal?: boolean;
  ignoreUndefined?: boolean;
  eval?: (cmd: string, context: Record<string, unknown>, filename: string, cb: (err: Error | null, result?: unknown) => void) => void;
  writer?: (result: unknown) => string;
  breakEvalOnSigint?: boolean;
  preview?: boolean;
}

const decodeChunk = (data: unknown): string => {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < data.length; i++) s += String.fromCharCode(data[i]!);
    return s;
  }
  return String(data);
};

const defaultWriter = (v: unknown): string => {
  if (v === undefined) return 'undefined';
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'function') return `[Function${v.name ? ': ' + v.name : ' (anonymous)'}]`;
  try {
    const seen = new WeakSet();
    return JSON.stringify(v, (_k, val) => {
      if (typeof val === 'object' && val !== null) {
        if (seen.has(val)) return '[Circular]';
        seen.add(val);
      }
      if (typeof val === 'bigint') return val.toString() + 'n';
      if (typeof val === 'function') return `[Function]`;
      return val;
    }, 2) ?? String(v);
  } catch {
    return String(v);
  }
};

const isStatement = (src: string): boolean => {
  const t = src.trim();
  if (/^\s*(const|let|var|function|class|if|for|while|switch|return|throw|try|do|import|export)\b/.test(t)) return true;
  return false;
};

const hasUnclosedBrackets = (src: string): boolean => {
  let depth = 0;
  let inStr: string | null = null;
  let inTpl = false;
  let tplDepth = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (inTpl) {
      if (c === '\\') { i++; continue; }
      if (c === '$' && src[i + 1] === '{') { tplDepth++; i++; continue; }
      if (c === '`' && tplDepth === 0) { inTpl = false; continue; }
      if (c === '}' && tplDepth > 0) { tplDepth--; continue; }
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '`') { inTpl = true; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i += 2; while (i < src.length - 1 && !(src[i] === '*' && src[i + 1] === '/')) i++; i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
  }
  return depth > 0 || inStr !== null || inTpl;
};

const transformDeclaration = (src: string): string => {
  // Convert `let x = ...` or `const x = ...` or `var x = ...` to context-aware form
  const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?);?\s*$/.exec(src);
  if (m) {
    return `__replContext.${m[1]} = (${m[2]});`;
  }
  return src;
};

export class REPLServer extends EventEmitter {
  context: Record<string, unknown> = {};
  prompt: string;
  private _input: NonNullable<ReplOptions['input']>;
  private _output: NonNullable<ReplOptions['output']>;
  private _ignoreUndefined: boolean;
  private _writer: (v: unknown) => string;
  private _buffer = '';
  private _multilineBuffer = '';
  private _commands: Map<string, { help: string; action: (this: REPLServer, arg: string) => void }> = new Map();
  private _eval: ReplOptions['eval'];
  private _closed = false;

  constructor(opts: ReplOptions = {}) {
    super();
    this.prompt = opts.prompt ?? '> ';
    const g = globalThis as Record<string, unknown>;
    const proc = g['process'] as { stdin?: ReplOptions['input']; stdout?: ReplOptions['output'] } | undefined;
    this._input = opts.input ?? (proc?.stdin as ReplOptions['input']) ?? { on: () => undefined };
    this._output = opts.output ?? (proc?.stdout as ReplOptions['output']) ?? { write: () => undefined };
    this._ignoreUndefined = !!opts.ignoreUndefined;
    this._writer = opts.writer ?? defaultWriter;
    if (opts.eval) this._eval = opts.eval;
    this._setupBuiltinCommands();
    this._attachInput();
    this.displayPrompt();
  }

  private _setupBuiltinCommands(): void {
    this.defineCommand('help', {
      help: 'Print this help message',
      action: function () {
        for (const [name, cmd] of (this as REPLServer)._commands) {
          (this as REPLServer)._write(`.${name}    ${cmd.help}\n`);
        }
        (this as REPLServer).displayPrompt();
      },
    });
    this.defineCommand('exit', {
      help: 'Exit the REPL',
      action: function () {
        (this as REPLServer).close();
      },
    });
    this.defineCommand('clear', {
      help: 'Clear the local context',
      action: function () {
        const me = this as REPLServer;
        me.context = {};
        me._write('Clearing context...\n');
        me.displayPrompt();
      },
    });
    this.defineCommand('break', {
      help: 'Sometimes you get stuck, this gets you out',
      action: function () {
        const me = this as REPLServer;
        me._multilineBuffer = '';
        me.displayPrompt();
      },
    });
  }

  private _attachInput(): void {
    if (this._input.setEncoding) this._input.setEncoding('utf8');
    if (this._input.resume) this._input.resume();
    this._input.on('data', (chunk: unknown) => {
      if (this._closed) return;
      this._buffer += decodeChunk(chunk);
      let newlineIdx;
      while ((newlineIdx = this._buffer.indexOf('\n')) !== -1) {
        const line = this._buffer.slice(0, newlineIdx);
        this._buffer = this._buffer.slice(newlineIdx + 1);
        this._handleLine(line);
        if (this._closed) return;
      }
    });
  }

  private _write(text: string): void {
    try { this._output.write(text); } catch { /* */ }
  }

  displayPrompt(preserveCursor?: boolean): void {
    void preserveCursor;
    if (this._closed) return;
    const p = this._multilineBuffer ? '... ' : this.prompt;
    this._write(p);
  }

  private _handleLine(line: string): void {
    // Handle REPL dot-commands when no multiline buffer in progress
    if (!this._multilineBuffer && line.startsWith('.')) {
      const spaceIdx = line.indexOf(' ');
      const name = spaceIdx === -1 ? line.slice(1) : line.slice(1, spaceIdx);
      const arg = spaceIdx === -1 ? '' : line.slice(spaceIdx + 1);
      const cmd = this._commands.get(name);
      if (cmd) {
        try { cmd.action.call(this, arg); }
        catch (e) { this._write(`error: ${(e as Error).message}\n`); this.displayPrompt(); }
        return;
      }
      this._write(`Invalid REPL keyword: .${name}\n`);
      this.displayPrompt();
      return;
    }

    const combined = this._multilineBuffer + (this._multilineBuffer ? '\n' : '') + line;
    if (hasUnclosedBrackets(combined)) {
      this._multilineBuffer = combined;
      this.displayPrompt();
      return;
    }
    this._multilineBuffer = '';
    this._eval ? this._eval(combined + '\n', this.context, 'repl', (err, result) => this._finishEval(err, result))
               : this._defaultEval(combined, (err, result) => this._finishEval(err, result));
  }

  private _finishEval(err: Error | null, result: unknown): void {
    if (err) {
      const msg = (err.stack ?? String(err));
      this._write('Uncaught ' + msg + '\n');
    } else if (!(this._ignoreUndefined && result === undefined)) {
      this._write(this._writer(result) + '\n');
    }
    this.displayPrompt();
  }

  private _defaultEval(src: string, cb: (err: Error | null, result?: unknown) => void): void {
    const trimmed = src.trim();
    if (!trimmed) { cb(null, undefined); return; }
    // Make context available as the magic global so eval'd code can update it.
    const g = globalThis as Record<string, unknown>;
    g['__replContext'] = this.context;
    // Install context vars as globals for the eval (so user-defined names work
    // across lines).
    for (const [k, v] of Object.entries(this.context)) {
      g[k] = v;
    }

    const isExpr = !isStatement(trimmed);
    let code: string;
    if (isExpr) {
      code = `(async () => (${trimmed}))()`;
    } else {
      const transformed = transformDeclaration(trimmed);
      code = `(async () => { ${transformed}\nreturn undefined; })()`;
    }

    let result: unknown;
    try {
      const g2 = globalThis as Record<string, unknown>;
      const evalRef = g2['eval'] as (s: string) => unknown;
      const ret = evalRef(code) as Promise<unknown>;
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        (ret as Promise<unknown>).then((val) => {
          // Sync globalThis back into context (declarations may have added there)
          for (const k of Object.keys(g)) {
            if (k.startsWith('_') || k === 'globalThis') continue;
            // Only sync keys that look user-defined (heuristic)
          }
          cb(null, val);
        }, (e) => cb(e as Error));
        return;
      }
      result = ret;
    } catch (e) {
      cb(e as Error);
      return;
    }
    cb(null, result);
  }

  defineCommand(name: string, cmd: { help: string; action: (this: REPLServer, arg: string) => void }): void {
    this._commands.set(name, cmd);
  }

  close(): void {
    if (this._closed) return;
    this._closed = true;
    this.emit('exit');
    this.emit('close');
  }
}

export const start = (opts: ReplOptions = {}): REPLServer => new REPLServer(opts);

export const nodeRepl = {
  start,
  REPLServer,
  REPL_MODE_SLOPPY: 0,
  REPL_MODE_STRICT: 1,
};

export const default_ = nodeRepl;
