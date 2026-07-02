import { test, expect } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

// Regression: dispatch envelopes (signals) delivered during engine boot must
// NOT preempt the entry script. If a SIGTERM envelope runs before the entry
// has installed process.on('SIGTERM'), the default action (terminate, exit 128+15
// = 143) fires and the entry is never executed. See src/host/engine-instance.ts
// handlers.wait — queue drains before dispatchQueue.
test('engine: entry body runs before dispatch envelope queued during boot', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary(
    '/bin/prelude-writer',
    `process.stdout.write('BODY_RAN');
     process.exit(0);`
  );
  const proc = await pm.spawn('/bin/prelude-writer', [], { cwd: '/' });
  // Deliver signal immediately — this races the entry boot. With the buggy
  // priority (dispatch first), the SIGTERM envelope evaluates before the entry
  // and hits the default-terminate branch → exit code 143 and no BODY_RAN output.
  pm._deliverSignal(proc.pid, 'SIGTERM');
  const code = await proc.exit;
  const reader = proc.stdout.getReader();
  let txt = '';
  while (true) { const r = await reader.read(); if (r.done) break; txt += new TextDecoder().decode(r.value); }
  expect(code).toBe(0);
  expect(txt).toContain('BODY_RAN');
}, 30_000);
