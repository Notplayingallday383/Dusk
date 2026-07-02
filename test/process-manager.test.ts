import { test, expect } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('ProcessManager spawn with builtin runs to exit 0', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/true', '');
  const proc = await pm.spawn('/bin/true', [], { cwd: '/' });
  const code = await proc.exit;
  expect(code).toBe(0);
}, 60_000);

test('ProcessManager spawn with explicit exit code', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/false', 'process.exit(1);');
  const proc = await pm.spawn('/bin/false', [], { cwd: '/' });
  const code = await proc.exit;
  expect(code).toBe(1);
}, 60_000);

test('ProcessManager spawn captures stdout via stream', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/echo', "const msg = process.argv.slice(1).join(' ') + '\\n'; process.stdout.write(msg);");
  const proc = await pm.spawn('/bin/echo', ['hello'], { cwd: '/' });
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  let done = false;
  while (!done) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  expect(new TextDecoder().decode(out)).toContain('hello');
  await proc.exit;
}, 60_000);

test('ProcessManager spawnSync collects stdout', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/echo', "const msg = process.argv.slice(1).join(' ') + '\\n'; process.stdout.write(msg);");
  const result = await pm.spawnSync('/bin/echo', ['hello'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('hello');
}, 60_000);

test('ProcessManager spawn reads stdin from options and echoes via stdout', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Binary reads one chunk from stdin via proc.readStdin (loop while value is []) and writes it to stdout.
  pm.registerBinary(
    '/bin/cat-one',
    "let r; while (true) { r = ipc.send({ f: 'proc.readStdin' }); if (r.value === null) { break; } if (r.value && r.value.length) { process.stdout.write(new Uint8Array(r.value)); break; } } process.exit(0);",
  );
  const input = new TextEncoder().encode('hello-stdin');
  const proc = await pm.spawn('/bin/cat-one', [], { cwd: '/', stdin: input });
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  expect(new TextDecoder().decode(out)).toBe('hello-stdin');
  expect(await proc.exit).toBe(0);
}, 60_000);

test('ProcessManager spawn routes stderr writes to stderr stream', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/errgen', "process.stderr.write('err\\n'); process.exit(0);");
  const proc = await pm.spawn('/bin/errgen', [], { cwd: '/' });
  const reader = proc.stderr.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  expect(new TextDecoder().decode(out)).toContain('err');
  expect(await proc.exit).toBe(0);
}, 60_000);

test('ProcessManager spawn late stream attach preserves backlog', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/echo2', "process.stdout.write('backlog-data'); process.exit(0);");
  const proc = await pm.spawn('/bin/echo2', [], { cwd: '/' });
  // Wait for exit BEFORE attaching a reader; chunks should still be readable.
  expect(await proc.exit).toBe(0);
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  const total = chunks.reduce((a, c) => a + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0; for (const c of chunks) { out.set(c, off); off += c.length; }
  expect(new TextDecoder().decode(out)).toContain('backlog-data');
}, 60_000);
