import { test, expect } from 'vitest';
import { createPipeChannel } from '../src/shell/pipe-channel';

const encode = (s: string): Uint8Array => new TextEncoder().encode(s);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 32; i++) await Promise.resolve();
};

test('pipe-channel: write then close, reader sees chunks then EOF', async () => {
  const ch = createPipeChannel(4);
  await ch.write(encode('hello '));
  await ch.write(encode('world'));
  ch.close();
  const chunks: string[] = [];
  for await (const c of ch.readable) chunks.push(decode(c));
  expect(chunks.join('')).toBe('hello world');
});

test('pipe-channel: capacity blocks producer until consumer drains', async () => {
  const ch = createPipeChannel(2);
  let resolved = 0;
  const writes = [
    ch.write(encode('a')).then(() => { resolved++; }),
    ch.write(encode('b')).then(() => { resolved++; }),
    ch.write(encode('c')).then(() => { resolved++; }), // should pend
  ];
  await flushMicrotasks();
  expect(resolved).toBe(2);

  const it = ch.readable[Symbol.asyncIterator]();
  await it.next(); // drain one
  await flushMicrotasks();
  expect(resolved).toBe(3);

  ch.close();
  await Promise.all(writes);
});

test('pipe-channel: closeReader makes future writes reject with EPIPE', async () => {
  const ch = createPipeChannel(4);
  await ch.write(encode('a'));
  ch.closeReader();
  await expect(ch.write(encode('b'))).rejects.toMatchObject({ code: 'EPIPE' });
});

test('pipe-channel: closeReader unblocks a pending writer with EPIPE', async () => {
  const ch = createPipeChannel(1);
  await ch.write(encode('a'));         // fills capacity
  const pending = ch.write(encode('b')); // pends
  ch.closeReader();
  await expect(pending).rejects.toMatchObject({ code: 'EPIPE' });
});

test('pipe-channel: close after writes returns done to reader', async () => {
  const ch = createPipeChannel(4);
  await ch.write(encode('x'));
  ch.close();
  const it = ch.readable[Symbol.asyncIterator]();
  expect(decode((await it.next()).value as Uint8Array)).toBe('x');
  expect((await it.next()).done).toBe(true);
});

test('pipe-channel: isClosed reflects reader state', () => {
  const ch = createPipeChannel(4);
  expect(ch.isClosed()).toBe(false);
  ch.closeReader();
  expect(ch.isClosed()).toBe(true);
});
