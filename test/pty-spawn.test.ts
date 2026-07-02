import { test, expect } from 'vitest';
import { createPty } from '../src/host/pty';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

const joinBytes = (arrs: Uint8Array[]): string => {
  let s = '';
  for (const a of arrs) {
    for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]!);
  }
  return s;
};

const bytes = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};

test('createPty hooks: cooked mode flushes a line to onSlaveStdin and echoes CR-LF', () => {
  const slaveIn: Uint8Array[] = [];
  const sigs: string[] = [];
  const master: Uint8Array[] = [];
  const pty = createPty(1, {}, {
    onSlaveStdin: (b) => slaveIn.push(b),
    onSignal: (s) => sigs.push(s),
    onSigwinch: () => {},
  });
  pty.onMasterData((b) => master.push(b));
  pty.masterWrite(bytes('hi\r'));
  expect(joinBytes(slaveIn)).toBe('hi\n');
  expect(joinBytes(master)).toBe('hi\r\n');
  expect(sigs).toEqual([]);
});

test('createPty: slaveWrite applies ONLCR in cooked mode and passes through in raw', () => {
  const master: Uint8Array[] = [];
  const pty = createPty(2, {});
  pty.onMasterData((b) => master.push(b));
  pty.slaveWrite(bytes('out\n'));
  pty.setRawMode(true);
  pty.slaveWrite(bytes('raw\n'));
  expect(joinBytes(master)).toBe('out\r\nraw\n');
});

test('createPty: ^C in cooked mode fires onSignal SIGINT and does not echo a byte', () => {
  const sigs: string[] = [];
  const master: Uint8Array[] = [];
  const pty = createPty(3, {}, { onSignal: (s) => sigs.push(s) });
  pty.onMasterData((b) => master.push(b));
  pty.masterWrite(new Uint8Array([0x03]));
  expect(sigs).toEqual(['SIGINT']);
  expect(master.length).toBe(0);
});

test('spawn pty:true: child stdout flows to master with CR-LF translation', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/say', `process.stdout.write('out\\n'); process.exit(0)`);
  const seen: Uint8Array[] = [];
  const proc = await pm.spawn('/bin/say', [], { cwd: '/', pty: true });
  proc.master!.onMasterData((b) => seen.push(b));
  await proc.exit;
  expect(joinBytes(seen)).toBe('out\r\n');
}, 60_000);

test('spawn pty:true: ^C on master delivers SIGINT to child, exit 130', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/loop', `await new Promise(() => {})`);
  const proc = await pm.spawn('/bin/loop', [], { cwd: '/', pty: true });
  proc.master!.masterWrite(new Uint8Array([0x03]));
  const code = await proc.exit;
  expect(code).toBe(130);
}, 60_000);

test('spawn pty:true: in raw mode, ^C bytes pass through without signal', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/loop', `await new Promise(() => {})`);
  const proc = await pm.spawn('/bin/loop', [], { cwd: '/', pty: true });
  proc.master!.setRawMode(true);
  proc.master!.masterWrite(new Uint8Array([0x03]));
  // Give the dispatch loop a tick; child must still be alive.
  await new Promise((r) => setTimeout(r, 30));
  proc.kill();
  const code = await proc.exit;
  expect(code).not.toBe(130); // killed via terminate, not SIGINT
}, 60_000);

test('spawn pty:true: master.resize(80,24) delivers SIGWINCH and updates columns', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Park on a Promise gate resolved inside the SIGWINCH handler. Read winsize
  // via ipc.send (world does not expose __call as a global).
  pm.registerBinary(
    '/bin/winch',
    `let resolveGate;
     const gate = new Promise((r) => { resolveGate = r });
     process.on('SIGWINCH', () => {
       const r = ipc.send({ f: 'tty.getWinSize' });
       const sz = r.value;
       process.stdout.write('cols=' + (sz ? sz[0] : 'x'));
       resolveGate();
     });
     await gate;
     process.exit(0)`,
  );
  const proc = await pm.spawn('/bin/winch', [], { cwd: '/', pty: { cols: 120, rows: 40 } });
  const seen: Uint8Array[] = [];
  proc.master!.onMasterData((b) => seen.push(b));
  proc.master!.resize(80, 24);
  await proc.exit;
  expect(joinBytes(seen)).toContain('cols=80');
}, 60_000);

test('spawn pty:true: process.stdout.columns reflects the configured cols', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/cols', `process.stdout.write(String(process.stdout.columns)); process.exit(0);`);
  const proc = await pm.spawn('/bin/cols', [], { cwd: '/', pty: { cols: 132, rows: 50 } });
  const seen: Uint8Array[] = [];
  proc.master!.onMasterData((b) => seen.push(b));
  await proc.exit;
  expect(joinBytes(seen)).toBe('132');
}, 60_000);

test('spawn pty:true: process.stdout.write reaches master', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/hi', `process.stdout.write('hi\\n'); process.exit(0);`);
  const proc = await pm.spawn('/bin/hi', [], { cwd: '/', pty: true });
  const chunks: Uint8Array[] = [];
  proc.master!.onMasterData((b) => chunks.push(b));
  await proc.exit;
  expect(joinBytes(chunks)).toBe('hi\r\n');
}, 60_000);

test('spawn with pty:true returns a master and child reads stdin from line discipline', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  // Poll proc.readStdin; on first non-empty chunk, echo it and exit.
  // Yield between polls so host-side masterWrite has a chance to enqueue.
  pm.registerBinary(
    '/bin/readline',
    "(async () => { while (true) { const r = ipc.send({ f: 'proc.readStdin' }); if (r.value === null) { process.exit(0); return; } if (r.value && r.value.length) { process.stdout.write(new Uint8Array(r.value)); process.exit(0); return; } await new Promise(res => setTimeout(res, 5)); } })()",
  );
  const proc = await pm.spawn('/bin/readline', [], { cwd: '/', pty: true });
  expect(proc.master).toBeDefined();
  proc.master!.masterWrite(bytes('hello\r'));
  const reader = proc.stdout.getReader();
  const chunks: Uint8Array[] = [];
  while (true) {
    const r = await reader.read();
    if (r.done) break;
    chunks.push(r.value);
  }
  expect(joinBytes(chunks)).toBe('hello\n');
  expect(await proc.exit).toBe(0);
}, 60_000);
