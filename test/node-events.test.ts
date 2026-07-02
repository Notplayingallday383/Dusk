import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:events EventEmitter on/emit/once/off/removeAllListeners', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const { EventEmitter } = require('node:events'); " +
    "const e = new EventEmitter(); " +
    "let onCount = 0, onceCount = 0; " +
    "const h = (n) => { onCount += n; }; " +
    "e.on('tick', h); " +
    "e.once('boom', (n) => { onceCount += n; }); " +
    "e.emit('tick', 2); e.emit('tick', 3); " +
    "e.emit('boom', 10); e.emit('boom', 20); " +
    "e.off('tick', h); e.emit('tick', 100); " +
    "const e2 = new EventEmitter(); let z = 0; e2.on('x', () => z++); e2.on('x', () => z++); e2.removeAllListeners('x'); e2.emit('x'); " +
    "process.stdout.write('E:on=' + onCount + '|once=' + onceCount + '|afterOff=' + onCount + '|z=' + z + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('E:on=5|');
  expect(s).toContain('once=10');
  expect(s).toContain('afterOff=5');
  expect(s).toContain('z=0');
}, 60_000);
