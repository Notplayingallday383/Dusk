import { describe, it, expect, vi } from 'vitest';
import { createStreamRegistry, STREAM_INITIAL_WINDOW } from '../src/host/stream-registry';

describe('StreamRegistry credit window', () => {
  it('exposes STREAM_INITIAL_WINDOW of 64 KiB', () => {
    expect(STREAM_INITIAL_WINDOW).toBe(64 * 1024);
  });

  it('seeds new streams with STREAM_INITIAL_WINDOW credit', () => {
    const r = createStreamRegistry();
    const id = r.allocate();
    expect(r.availableCredit(id)).toBe(STREAM_INITIAL_WINDOW);
  });

  it('debits credit by chunk byte length on pushChunk', () => {
    const r = createStreamRegistry();
    const id = r.allocate();
    r.register({
      id, producerPid: 0, consumerPid: 0,
      onChunk: () => {}, onEnd: () => {}, onError: () => {},
    });
    r.pushChunk(id, new Uint8Array(1000));
    expect(r.availableCredit(id)).toBe(STREAM_INITIAL_WINDOW - 1000);
  });

  it('grantCredit fires onResume when crossing from <=0 back to >0', () => {
    const r = createStreamRegistry();
    const id = r.allocate();
    const onResume = vi.fn();
    const onLow = vi.fn();
    r.register({
      id, producerPid: 0, consumerPid: 0,
      onChunk: () => {}, onEnd: () => {}, onError: () => {},
      onLow, onResume,
    });
    // Drain to zero
    r.pushChunk(id, new Uint8Array(STREAM_INITIAL_WINDOW));
    expect(onLow).toHaveBeenCalledTimes(1);
    expect(r.availableCredit(id)).toBe(0);
    // Grant back
    r.grantCredit(id, 4096);
    expect(onResume).toHaveBeenCalledTimes(1);
    expect(r.availableCredit(id)).toBe(4096);
  });

  it('pushEnd and pushError release the credit bookkeeping', () => {
    const r = createStreamRegistry();
    const id = r.allocate();
    r.register({
      id, producerPid: 0, consumerPid: 0,
      onChunk: () => {}, onEnd: () => {}, onError: () => {},
    });
    r.pushEnd(id);
    expect(r.availableCredit(id)).toBe(0); // map entry deleted; returns default 0
  });
});
