import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:repl module is requirable and has start()', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const r = require('node:repl'); process.stdout.write('type=' + typeof r.start + ',SRV=' + typeof r.REPLServer + '\\n')\n");
  await new Promise((r) => setTimeout(r, 600));
  const text = out.join('');
  expect(text).toContain('type=function');
  expect(text).toContain('SRV=function');
  repl.engine.terminate();
}, 60_000);

test('repl.start evaluates expressions and writes to output', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(`
    const r = require('node:repl');
    let dataHandler;
    const inp = {
      on(ev, cb) { if (ev === 'data') dataHandler = cb; return this; },
      resume() { return this; },
      setEncoding() { return this; },
    };
    const captured = [];
    const outp = { write(s) { captured.push(String(s)); } };
    const srv = r.start({ input: inp, output: outp, prompt: '> ', ignoreUndefined: false });
    // Feed lines synchronously; the default eval is async so we need to await
    dataHandler('1 + 2\\n');
    await new Promise((r) => setTimeout(r, 50));
    dataHandler('"hi".toUpperCase()\\n');
    await new Promise((r) => setTimeout(r, 50));
    process.stdout.write('CAPTURE=' + captured.join('|') + '\\nEND\\n');
  `.trim() + '\n');
  await new Promise((r) => setTimeout(r, 1500));
  const text = out.join('');
  expect(text).toContain('CAPTURE=');
  expect(text).toContain('3');
  expect(text).toContain('HI');
  repl.engine.terminate();
}, 60_000);
