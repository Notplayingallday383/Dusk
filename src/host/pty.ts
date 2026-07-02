// Host-side PTY emulation.
//
// A Pty is a "pseudo terminal" — a bidirectional byte stream with line
// discipline (cooked mode echoes input + handles ^C/^D, raw mode passes
// bytes through). cols/rows track terminal size; resize emits SIGWINCH.

export interface PtyOptions {
  cols?: number;
  rows?: number;
}

export interface PtyHooks {
  onSlaveStdin?: (bytes: Uint8Array) => void;
  onSignal?: (sig: string) => void;
  onSigwinch?: (cols: number, rows: number) => void;
}

export interface Pty {
  pid: number;
  cols: number;
  rows: number;
  rawMode: boolean;
  // Master side: host code reads/writes via these.
  masterWrite(bytes: Uint8Array): void;
  onMasterData(cb: (bytes: Uint8Array) => void): void;
  // Slave side: engine code reads/writes via these (typically wired through
  // stdio streams in the engine).
  slaveWrite(bytes: Uint8Array): void;
  // Resize triggers SIGWINCH on the foreground process group.
  resize(cols: number, rows: number): void;
  setRawMode(raw: boolean): void;
  close(): void;
}

class LineDiscipline {
  private buffer = '';

  // Process input from master toward slave.
  // In cooked mode: handle ^C/^D, echo printable, buffer until \r/\n, emit line.
  // In raw mode: pass through unchanged.
  processInput(input: Uint8Array, raw: boolean, onEcho: (bytes: Uint8Array) => void, onLine: (bytes: Uint8Array) => void, onSignal: (sig: string) => void): void {
    if (raw) {
      onLine(input);
      return;
    }
    let str = '';
    for (let i = 0; i < input.length; i++) str += String.fromCharCode(input[i]!);
    for (const c of str) {
      const code = c.charCodeAt(0);
      if (code === 3) { onSignal('SIGINT'); continue; }       // ^C
      if (code === 4) {                                         // ^D
        if (this.buffer.length === 0) { onLine(new Uint8Array(0)); }
        else { onLine(new TextEncoder().encode(this.buffer)); this.buffer = ''; }
        continue;
      }
      if (code === 28) { onSignal('SIGQUIT'); continue; }     // ^\
      if (code === 26) { onSignal('SIGTSTP'); continue; }     // ^Z
      if (code === 127 || code === 8) {                       // backspace / DEL
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          onEcho(new Uint8Array([8, 32, 8]));  // BS, space, BS
        }
        continue;
      }
      if (code === 13 || code === 10) {                        // \r or \n
        this.buffer += '\n';
        onEcho(new Uint8Array([13, 10]));
        onLine(new TextEncoder().encode(this.buffer));
        this.buffer = '';
        continue;
      }
      this.buffer += c;
      onEcho(new Uint8Array([code]));
    }
  }

  // Process output from slave toward master.
  // In cooked mode: expand \n → \r\n (ONLCR) unless already preceded by \r.
  // In raw mode: pass through unchanged.
  processOutput(bytes: Uint8Array, raw: boolean): Uint8Array {
    if (raw) return bytes;
    let extra = 0;
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) extra++;
    }
    if (extra === 0) return bytes;
    const out = new Uint8Array(bytes.length + extra);
    let j = 0;
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      if (b === 0x0a && (i === 0 || bytes[i - 1] !== 0x0d)) {
        out[j++] = 0x0d;
      }
      out[j++] = b;
    }
    return out;
  }
}

export const createPty = (pid: number, opts: PtyOptions = {}, hooks: PtyHooks = {}): Pty => {
  let cols = opts.cols ?? 80;
  let rows = opts.rows ?? 24;
  let rawMode = false;
  let masterDataCb: ((b: Uint8Array) => void) | null = null;
  const onSlaveStdin = hooks.onSlaveStdin ?? ((_b: Uint8Array): void => { /* drop */ });
  const onSignalHook = hooks.onSignal ?? ((_s: string): void => { /* drop */ });
  const onSigwinchHook = hooks.onSigwinch ?? ((_c: number, _r: number): void => { /* drop */ });
  const discipline = new LineDiscipline();
  let closed = false;

  return {
    pid,
    get cols() { return cols; },
    get rows() { return rows; },
    get rawMode() { return rawMode; },
    masterWrite(bytes) {
      if (closed) return;
      discipline.processInput(
        bytes,
        rawMode,
        (echo) => masterDataCb?.(echo),
        (line) => onSlaveStdin(line),
        (sig) => onSignalHook(sig),
      );
    },
    onMasterData(cb) {
      masterDataCb = cb;
    },
    slaveWrite(bytes) {
      if (closed) return;
      const transformed = discipline.processOutput(bytes, rawMode);
      masterDataCb?.(transformed);
    },
    resize(newCols, newRows) {
      cols = newCols;
      rows = newRows;
      onSigwinchHook(cols, rows);
    },
    setRawMode(raw) {
      rawMode = raw;
    },
    close() {
      closed = true;
    },
  };
};

export interface PtyManager {
  attach(pid: number, opts?: PtyOptions, hooks?: PtyHooks): Pty;
  get(pid: number): Pty | undefined;
  detach(pid: number): void;
  resize(pid: number, cols: number, rows: number): void;
}

export const createPtyManager = (): PtyManager => {
  const ptys = new Map<number, Pty>();
  return {
    attach(pid, opts, hooks) {
      if (ptys.has(pid)) return ptys.get(pid)!;
      const pty = createPty(pid, opts, hooks);
      ptys.set(pid, pty);
      return pty;
    },
    get(pid) { return ptys.get(pid); },
    detach(pid) {
      const p = ptys.get(pid);
      if (p) { p.close(); ptys.delete(pid); }
    },
    resize(pid, cols, rows) {
      const p = ptys.get(pid);
      if (p) p.resize(cols, rows);
    },
  };
};
