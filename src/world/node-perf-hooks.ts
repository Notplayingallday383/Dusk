// node:perf_hooks — backed by global performance.now() and a minimal
// PerformanceObserver implementation.

import { EventEmitter } from './node-events';

declare const performance: { now(): number; timeOrigin?: number } | undefined;

const _now = (): number => (typeof performance !== 'undefined' && performance ? performance.now() : Date.now());
const _origin = typeof performance !== 'undefined' && performance ? (performance.timeOrigin ?? Date.now() - performance.now()) : Date.now();

export class PerformanceEntry {
  name: string;
  entryType: string;
  startTime: number;
  duration: number;
  detail: unknown;
  constructor(name: string, entryType: string, startTime: number, duration: number, detail?: unknown) {
    this.name = name;
    this.entryType = entryType;
    this.startTime = startTime;
    this.duration = duration;
    this.detail = detail;
  }
  toJSON(): Record<string, unknown> {
    return { name: this.name, entryType: this.entryType, startTime: this.startTime, duration: this.duration };
  }
}

export class PerformanceMark extends PerformanceEntry {
  constructor(name: string, time: number, detail?: unknown) {
    super(name, 'mark', time, 0, detail);
  }
}

export class PerformanceMeasure extends PerformanceEntry {
  constructor(name: string, startTime: number, duration: number, detail?: unknown) {
    super(name, 'measure', startTime, duration, detail);
  }
}

const _entries: PerformanceEntry[] = [];
const _marks = new Map<string, PerformanceMark>();

const _observers: PerformanceObserver[] = [];

const _notify = (entry: PerformanceEntry): void => {
  for (const obs of _observers) (obs as unknown as { _maybeEnqueue: (e: PerformanceEntry) => void })._maybeEnqueue(entry);
};

export class PerformanceObserverEntryList {
  private entries: PerformanceEntry[];
  constructor(entries: PerformanceEntry[]) { this.entries = entries; }
  getEntries(): PerformanceEntry[] { return this.entries.slice(); }
  getEntriesByName(name: string, type?: string): PerformanceEntry[] {
    return this.entries.filter((e) => e.name === name && (!type || e.entryType === type));
  }
  getEntriesByType(type: string): PerformanceEntry[] {
    return this.entries.filter((e) => e.entryType === type);
  }
}

export interface PerformanceObserverInit {
  entryTypes?: string[];
  type?: string;
  buffered?: boolean;
}

export class PerformanceObserver {
  private _callback: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void;
  private _types = new Set<string>();
  private _buffer: PerformanceEntry[] = [];
  private _connected = false;

  constructor(cb: (list: PerformanceObserverEntryList, observer: PerformanceObserver) => void) {
    this._callback = cb;
  }

  observe(options: PerformanceObserverInit): void {
    if (options.type) this._types.add(options.type);
    if (options.entryTypes) for (const t of options.entryTypes) this._types.add(t);
    if (!this._connected) {
      _observers.push(this);
      this._connected = true;
    }
    if (options.buffered) {
      for (const e of _entries) if (this._types.has(e.entryType)) this._buffer.push(e);
      this._flush();
    }
  }

  disconnect(): void {
    const idx = _observers.indexOf(this);
    if (idx >= 0) _observers.splice(idx, 1);
    this._connected = false;
    this._buffer.length = 0;
  }

  takeRecords(): PerformanceEntry[] {
    const out = this._buffer.slice();
    this._buffer.length = 0;
    return out;
  }

  _maybeEnqueue(entry: PerformanceEntry): void {
    if (!this._types.has(entry.entryType)) return;
    this._buffer.push(entry);
    Promise.resolve().then(() => this._flush());
  }

  private _flush(): void {
    if (this._buffer.length === 0) return;
    const list = new PerformanceObserverEntryList(this._buffer.splice(0));
    try { this._callback(list, this); } catch { /* */ }
  }
}

class _Performance extends EventEmitter {
  readonly nodeTiming = { name: 'node', entryType: 'node', startTime: 0, duration: 0, nodeStart: 0, v8Start: 0, bootstrapComplete: 0, environment: 0, loopStart: 0, loopExit: 0 };
  readonly timeOrigin = _origin;
  readonly eventLoopUtilization = (..._args: unknown[]): { idle: number; active: number; utilization: number } => ({ idle: 0, active: 0, utilization: 0 });

  now(): number { return _now(); }

  mark(name: string, opts?: { detail?: unknown; startTime?: number }): PerformanceMark {
    const time = opts?.startTime ?? _now();
    const entry = new PerformanceMark(name, time, opts?.detail);
    _marks.set(name, entry);
    _entries.push(entry);
    _notify(entry);
    return entry;
  }

  measure(name: string, startOrOpts?: string | { start?: string | number; end?: string | number; detail?: unknown; duration?: number }, endMark?: string): PerformanceMeasure {
    let startTime: number, endTime: number, detail: unknown;
    if (typeof startOrOpts === 'object' && startOrOpts !== null) {
      const o = startOrOpts;
      startTime = typeof o.start === 'string' ? (_marks.get(o.start)?.startTime ?? _now()) : (typeof o.start === 'number' ? o.start : 0);
      endTime = typeof o.end === 'string' ? (_marks.get(o.end)?.startTime ?? _now()) : (typeof o.end === 'number' ? o.end : _now());
      if (o.duration !== undefined && o.start !== undefined) endTime = startTime + o.duration;
      detail = o.detail;
    } else {
      startTime = startOrOpts ? (_marks.get(startOrOpts)?.startTime ?? 0) : 0;
      endTime = endMark ? (_marks.get(endMark)?.startTime ?? _now()) : _now();
    }
    const entry = new PerformanceMeasure(name, startTime, endTime - startTime, detail);
    _entries.push(entry);
    _notify(entry);
    return entry;
  }

  clearMarks(name?: string): void {
    if (!name) {
      _marks.clear();
      for (let i = _entries.length - 1; i >= 0; i--) if (_entries[i]!.entryType === 'mark') _entries.splice(i, 1);
    } else {
      _marks.delete(name);
      for (let i = _entries.length - 1; i >= 0; i--) {
        const e = _entries[i]!;
        if (e.entryType === 'mark' && e.name === name) _entries.splice(i, 1);
      }
    }
  }

  clearMeasures(name?: string): void {
    for (let i = _entries.length - 1; i >= 0; i--) {
      const e = _entries[i]!;
      if (e.entryType === 'measure' && (!name || e.name === name)) _entries.splice(i, 1);
    }
  }

  getEntries(): PerformanceEntry[] { return _entries.slice(); }
  getEntriesByName(name: string, type?: string): PerformanceEntry[] {
    return _entries.filter((e) => e.name === name && (!type || e.entryType === type));
  }
  getEntriesByType(type: string): PerformanceEntry[] {
    return _entries.filter((e) => e.entryType === type);
  }
  clearResourceTimings(): void { /* */ }

  toJSON(): Record<string, unknown> { return { timeOrigin: this.timeOrigin, nodeTiming: this.nodeTiming }; }
}

export const performance_ = new _Performance();

export const monitorEventLoopDelay = (_opts?: { resolution?: number }): {
  enable(): void; disable(): void; reset(): void;
  min: number; max: number; mean: number; stddev: number; percentile(p: number): number;
} => ({
  enable() { /* */ },
  disable() { /* */ },
  reset() { /* */ },
  min: 0, max: 0, mean: 0, stddev: 0,
  percentile() { return 0; },
});

export const constants = Object.freeze({
  NODE_PERFORMANCE_GC_MAJOR: 4,
  NODE_PERFORMANCE_GC_MINOR: 1,
  NODE_PERFORMANCE_GC_INCREMENTAL: 8,
  NODE_PERFORMANCE_GC_WEAKCB: 16,
});

export const nodePerfHooks = {
  performance: performance_,
  PerformanceObserver,
  PerformanceEntry,
  PerformanceMark,
  PerformanceMeasure,
  PerformanceObserverEntryList,
  monitorEventLoopDelay,
  constants,
};
