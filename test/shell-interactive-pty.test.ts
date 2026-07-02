import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const decode = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return s;
};

const pump = async (stream: ReadableStream<Uint8Array>, into: (s: string) => void): Promise<void> => {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) into(decode(value));
    }
  } catch { /* */ }
};

// /bin/sh spawned with pty:true (like the demo page) should enter interactive
// mode and accept commands via the PTY master. Regression against the bug
// where TtyReadStream.read() always returned null (because Readable.read()
// with no push() source is empty), making the shell think stdin was closed
// on first poll and exit immediately.
test('/bin/sh with PTY: prompt shows, echo command produces output', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const sh = await repl.processManager.spawn('/bin/sh', [], {
    cwd: '/',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', USER: 'dusk' },
    pty: { cols: 80, rows: 24 },
  });

  let stdoutBuf = '';
  void pump(sh.stdout, (s) => { stdoutBuf += s; });

  const waitFor = async (marker: string, deadlineMs = 5_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (stdoutBuf.indexOf(marker) === -1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return stdoutBuf.indexOf(marker) !== -1;
  };

  // Wait for first prompt.
  expect(await waitFor('$ ')).toBe(true);

  // Send a command through the PTY master (like the demo does via sh.stdin.write).
  const encoder = new TextEncoder();
  await sh.stdin.write(encoder.encode('echo demo-works\n'));

  // Wait for output.
  expect(await waitFor('demo-works')).toBe(true);

  // Close stdin so shell exits cleanly.
  await sh.stdin.close();
  await sh.exit;
  repl.engine.terminate();
}, 30_000);

// PTY cooked-mode echo: characters typed at the master should be echoed back
// via the master's onMasterData callback (matches the demo's pattern —
// terminal UIs wire this to show what the user types before Enter).
test('/bin/sh with PTY: typed characters are echoed via master.onMasterData (cooked mode)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const sh = await repl.processManager.spawn('/bin/sh', [], {
    cwd: '/', env: { PATH: '/bin' }, pty: { cols: 80, rows: 24 },
  });

  let echoBuf = '';
  sh.master!.onMasterData((bytes) => { echoBuf += decode(bytes); });

  // Wait for stdout prompt via the regular pump — that's the shell's own $ write.
  let stdoutBuf = '';
  void pump(sh.stdout, (s) => { stdoutBuf += s; });

  const waitForOut = async (marker: string, deadlineMs = 5_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (stdoutBuf.indexOf(marker) === -1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return stdoutBuf.indexOf(marker) !== -1;
  };
  const waitForEcho = async (marker: string, deadlineMs = 3_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (echoBuf.indexOf(marker) === -1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return echoBuf.indexOf(marker) !== -1;
  };

  await waitForOut('$ ');

  // Type 'echo hi' character-by-character WITHOUT Enter — should be echoed
  // to the master (via onMasterData), not to stdout.
  const encoder = new TextEncoder();
  for (const c of 'echo hi') {
    await sh.stdin.write(encoder.encode(c));
  }
  expect(await waitForEcho('echo hi')).toBe(true);

  // Now send the newline to actually execute.
  await sh.stdin.write(encoder.encode('\n'));
  expect(await waitForOut('hi\n')).toBe(true);

  await sh.stdin.close();
  await sh.exit;
  repl.engine.terminate();
}, 30_000);

// New builtin binaries added for the demo: ls, mkdir, rm, touch, whoami, hostname, clear.
test('/bin/ls lists directory entries; mkdir/touch/rm round-trip works', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });

  // Verify /bin/ls on a known directory: use the spawn API directly.
  const r1 = await repl.processManager.spawnSync('/bin/ls', ['/bin'], { cwd: '/' });
  const lsOut = decode(r1.stdout);
  expect(r1.status).toBe(0);
  expect(lsOut).toContain('sh');
  expect(lsOut).toContain('echo');
  expect(lsOut).toContain('ls');

  // mkdir + touch + ls + rm round-trip.
  const r2 = await repl.processManager.spawnSync('/bin/mkdir', ['-p', '/tmp/demo-dir'], { cwd: '/' });
  expect(r2.status).toBe(0);
  const r3 = await repl.processManager.spawnSync('/bin/touch', ['/tmp/demo-dir/hello.txt'], { cwd: '/' });
  expect(r3.status).toBe(0);
  const r4 = await repl.processManager.spawnSync('/bin/ls', ['/tmp/demo-dir'], { cwd: '/' });
  expect(decode(r4.stdout)).toContain('hello.txt');
  const r5 = await repl.processManager.spawnSync('/bin/rm', ['/tmp/demo-dir/hello.txt'], { cwd: '/' });
  expect(r5.status).toBe(0);
  const r6 = await repl.processManager.spawnSync('/bin/ls', ['/tmp/demo-dir'], { cwd: '/' });
  expect(decode(r6.stdout).trim()).toBe('');

  repl.engine.terminate();
}, 30_000);

test('/bin/whoami and /bin/hostname produce expected output', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });

  const r1 = await repl.processManager.spawnSync('/bin/whoami', [], { cwd: '/', env: { USER: 'testuser' } });
  expect(decode(r1.stdout).trim()).toBe('testuser');

  const r2 = await repl.processManager.spawnSync('/bin/hostname', [], { cwd: '/' });
  const h = decode(r2.stdout).trim();
  expect(h.length).toBeGreaterThan(0);

  repl.engine.terminate();
}, 30_000);
