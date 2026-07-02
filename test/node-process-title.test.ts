import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('setting process.title IPCs to host and updates ProcessRecord', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "process.title = 'my-cool-proc';" +
    "process.stdout.write('local=' + process.title)\n"
  );
  repl.engine.terminate();
  expect(out.join('')).toContain('local=my-cool-proc');
  const rec = repl.processManager.getProcessRecord(0);
  expect(rec).toBeDefined();
  expect(rec!.title).toBe('my-cool-proc');
}, 60_000);

test('process.title getter returns the locally cached value (no IPC)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("process.stdout.write('initial=' + process.title)\n");
  repl.engine.terminate();
  expect(out.join('')).toContain('initial=duskjs');
}, 60_000);
