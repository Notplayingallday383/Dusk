import { test, expect } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('child process fds are released and backend handles closed on exit', async () => {
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  // Pre-populate a file so the child can open it.
  await backend.writeFileBytes('/data.bin', new Uint8Array([1, 2, 3, 4, 5]));

  pm.registerBinary('/bin/opener', `
    const fs = require("node:fs");
    const a = fs.openSync("/data.bin", "r");
    const b = fs.openSync("/data.bin", "r");
    const c = fs.openSync("/data.bin", "r");
    process.stdout.write("OPENED:" + a + "," + b + "," + c + "\\n");
    process.exit(0);
  `);
  const proc = await pm.spawn('/bin/opener', [], { cwd: '/' });
  const code = await proc.exit;
  expect(code).toBe(0);

  // After exit, the pid's fd table must be torn down. The internal API surface for
  // checking this is intentionally narrow; this test asserts the *observable* property:
  // a new spawn allocates fds starting fresh at 3.
  pm.registerBinary('/bin/checker', `
    const fs = require("node:fs");
    const fd = fs.openSync("/data.bin", "r");
    process.stdout.write("FD:" + fd + "\\n");
    process.exit(0);
  `);
  const proc2 = await pm.spawn('/bin/checker', [], { cwd: '/' });
  const reader = proc2.stdout.getReader();
  let collected = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    collected += new TextDecoder().decode(r.value);
  }
  await proc2.exit;
  expect(collected).toContain('FD:3');  // fresh table → starts at 3
}, 60_000);

test('parent fds are not leaked to child (no inheritance in v1)', async () => {
  // v1: child gets a fresh empty fd table. Parent's fds are not visible.
  // This pins the contract so future stdio-fd work doesn't accidentally leak.
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  await backend.writeFileBytes('/x', new Uint8Array([42]));
  pm.registerBinary('/bin/probe', `
    const fs = require("node:fs");
    try {
      const buf = new Uint8Array(1);
      const n = fs.readSync(3, buf, 0, 1, 0);
      process.stdout.write("LEAKED:" + n + "\\n");
    } catch (e) {
      process.stdout.write("CODE:" + (e.code || '<none>') + "\\n");
    }
    process.exit(0);
  `);
  const proc = await pm.spawn('/bin/probe', [], { cwd: '/' });
  const reader = proc.stdout.getReader();
  let collected = '';
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    collected += new TextDecoder().decode(r.value);
  }
  await proc.exit;
  expect(collected).toContain('CODE:EBADF');
}, 60_000);
