import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import { TRANSCRIPT_LINES, TRANSCRIPT_SEED, makeStubLibcurl } from '../src/demo/transcript';

test('REPL demo: the shared transcript runs end-to-end', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    net: { loadLibcurl: async () => makeStubLibcurl(), proxyUrl: 'wss://stub/ws/' },
    seed: TRANSCRIPT_SEED,
    fs: 'memory',
  });
  for (const line of TRANSCRIPT_LINES) {
    await repl.feed(line + '\n');
  }
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('11') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = out.join('');
  expect(text).toContain('2');
  expect(text).toContain('hello from DuskJS');
  expect(text).toContain('42');
  expect(text).toContain('7');
  expect(text).toContain('/a/b/c.txt');
  expect(text).toContain('hi from node:fs');
  expect(text).toContain('hello.txt');
  expect(text).toContain('/demo/hello.txt');
  expect(text).toContain('11');
}, 60_000);
