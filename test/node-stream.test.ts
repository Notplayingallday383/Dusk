import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// Note: plan's original test code used `new TextDecoder().decode(chunk)`, but
// TextDecoder is not defined in this SpiderMonkey engine build. Using
// `String(chunk)` instead — Buffer's toString override yields utf8 text.
test('node:stream Readable.from + Writable + pipe end-of-stream', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "(async () => { " +
    "const { Readable, Writable } = require('node:stream'); " +
    "const chunks = []; " +
    "const w = new Writable({ write: function(chunk, _enc, cb) { chunks.push(String(chunk)); cb(); } }); " +
    "let finished = false; w.on('finish', () => { finished = true; }); " +
    "const r = Readable.from(['one', 'two', 'three']); " +
    "r.pipe(w); " +
    "for (let i = 0; i < 200 && !finished; i++) { await new Promise((res) => setTimeout(res, 10)); } " +
    "process.stdout.write('S:joined=' + chunks.join(',') + '|count=' + chunks.length + '|finished=' + finished + ':END'); " +
    "})()\n"
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('S:joined=one,two,three|');
  expect(s).toContain('count=3');
  expect(s).toContain('finished=true');
}, 60_000);
