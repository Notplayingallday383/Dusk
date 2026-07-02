import { describe, it, expect, vi, beforeEach } from 'vitest';

// Inject a fake ipc before importing the module under test.
const sent: Array<{ f: string; args: Record<string, unknown> }> = [];
(globalThis as Record<string, unknown>)['ipc'] = {
  send: (m: Record<string, unknown>) => {
    const f = m['f'] as string;
    const { f: _f, ...rest } = m;
    sent.push({ f, args: rest });
    if (f === 'stream.allocate') return { value: { id: 1 } };
    return { value: true };
  },
};

beforeEach(() => { sent.length = 0; });

describe('engine streams credit', () => {
  it('createStreamSink sends stream.grantCredit when Readable consumer drains', async () => {
    const mod = await import('../src/world/engine-streams');
    const { id, readable } = mod.createStreamSink();
    expect(id).toBe(1);
    // Push some chunks via the dispatch hook (simulating host)
    const streamsAny = (globalThis as Record<string, unknown>)['__streams'] as { dispatch: (id: number, k: string, p?: unknown) => void };
    const dispatch = streamsAny.dispatch;
    dispatch(1, 'chunk', Array.from(new Uint8Array(8192)));
    dispatch(1, 'chunk', Array.from(new Uint8Array(8192)));
    // Consumer drains
    await new Promise<void>((resolve) => {
      let total = 0;
      readable.on('data', (...args: unknown[]) => {
        const b = args[0] as Uint8Array;
        total += b.byteLength;
        if (total === 16384) resolve();
      });
    });
    // Expect a grantCredit IPC send with amount summing to at least 16384
    const grants = sent.filter((s) => s.f === 'stream.grantCredit');
    const total = grants.reduce((a, g) => a + (g.args['amount'] as number), 0);
    expect(total).toBeGreaterThanOrEqual(16384);
    expect(grants[0]?.args['id']).toBe(1);
  });

  it('emits no grant after end-of-stream', async () => {
    const mod = await import('../src/world/engine-streams');
    const { readable } = mod.createStreamSink();
    const streamsAny = (globalThis as Record<string, unknown>)['__streams'] as { dispatch: (id: number, k: string, p?: unknown) => void };
    const dispatch = streamsAny.dispatch;
    // 'end' before any chunk: grants should be 0
    dispatch(2, 'end');
    await new Promise((r) => setTimeout(r, 0));
    readable.resume();
    const grants = sent.filter((s) => s.f === 'stream.grantCredit' && s.args['id'] === 2);
    expect(grants.length).toBe(0);
  });

  it('createStreamWritable applies backpressure when host returns a window deficit', async () => {
    // Override ipc for this test: stream.pushChunk debits a simulated 64 KiB
    // host window and returns the remaining credit. Once credit hits 0 the
    // engine should park subsequent writes until 'creditGranted' fires.
    const WINDOW = 64 * 1024;
    let hostCredit = WINDOW;
    const pushCalls: Array<{ id: number; len: number; creditAfter: number }> = [];
    (globalThis as Record<string, unknown>)['ipc'] = {
      send: (m: Record<string, unknown>) => {
        const f = m['f'] as string;
        if (f === 'stream.pushChunk') {
          const id = m['id'] as number;
          const data = m['data'] as number[];
          hostCredit -= data.length;
          pushCalls.push({ id, len: data.length, creditAfter: hostCredit });
          return { value: { credit: hostCredit } };
        }
        if (f === 'stream.pushEnd') return { value: true };
        return { value: true };
      },
    };

    const mod = await import('../src/world/engine-streams');
    const w = mod.createStreamWritable(42);
    const CHUNK = 32 * 1024;
    const chunk = new Uint8Array(CHUNK);

    // First write: fills half the window; cb should fire (credit still 32 KiB).
    const cb1Fired = { v: false };
    w.write(chunk, undefined, () => { cb1Fired.v = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(cb1Fired.v).toBe(true);

    // Second write: exhausts the window; cb should still fire (credit hits 0 exactly).
    // Under the plan's rule (park iff credit <= 0), this callback DOES park.
    const cb2Fired = { v: false };
    w.write(chunk, undefined, () => { cb2Fired.v = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(cb2Fired.v).toBe(false); // parked — credit == 0
    expect(pushCalls.length).toBe(2);

    // Third write: does NOT push yet because writable's internal queue serialises
    // through _write. Since _write hasn't called its cb yet, the queue holds it.
    const cb3Fired = { v: false };
    w.write(chunk, undefined, () => { cb3Fired.v = true; });
    await new Promise((r) => setTimeout(r, 0));
    expect(cb3Fired.v).toBe(false);
    // Still exactly 2 pushes on the wire — third is queued behind the parked one.
    expect(pushCalls.length).toBe(2);

    // Grant credit and dispatch creditGranted — the parked writer resumes and
    // both queued writes complete.
    hostCredit += WINDOW;
    const streamsAny = (globalThis as Record<string, unknown>)['__streams'] as { dispatch: (id: number, k: string, p?: unknown) => void };
    streamsAny.dispatch(42, 'creditGranted');
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(cb2Fired.v).toBe(true);
    expect(cb3Fired.v).toBe(true);
    expect(pushCalls.length).toBe(3);
  });
});
