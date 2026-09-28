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

test('ProcessManager invokes network cleanup when a spawned process exits', async () => {
  const cleaned: number[] = [];
  const pm = new ProcessManager(createMemoryBackend(), {}, {}, {
    cleanupNetworkForPid: (pid: number) => cleaned.push(pid),
  } as never);
  pm.registerBinary('/bin/exit', 'process.exit(0);');

  const result = await pm.spawnSync('/bin/exit', [], { cwd: '/' });

  expect(result.status).toBe(0);
  expect(cleaned).toEqual([1]);
}, 60_000);

test('ProcessManager runs trusted host binaries without a WASM engine', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerHostBinary('/bin/hello', ({ args }) => ({ status: 0, stdout: `hello ${args[0]}\n` }));

  const result = await pm.spawnSync('/bin/hello', ['dusk'], { cwd: '/' });

  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello dusk\n');
}, 60_000);

test('ProcessManager streams a registered host binary without a WASM engine', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let disconnects = 0;
  pm.registerStreamingHostBinary('/bin/ssh', ({ stdin, stdout, stderr }) => {
    const exit = (async () => {
      await stdout(encoder.encode('connected\n'));
      await stderr(encoder.encode('notice\n'));
      const reader = stdin.getReader();
      let input = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        input += decoder.decode(value, { stream: true });
      }
      await stdout(encoder.encode(`received:${input}\n`));
      return 0;
    })();
    return { exit, kill: () => { disconnects++; } };
  });

  const proc = await pm.spawn('/bin/ssh', ['host'], { cwd: '/' });
  const stdout = proc.stdout.getReader();
  const stderr = proc.stderr.getReader();
  expect(decoder.decode((await stdout.read()).value)).toBe('connected\n');
  expect(decoder.decode((await stderr.read()).value)).toBe('notice\n');

  await proc.stdin.write(encoder.encode('one '));
  await proc.stdin.write(encoder.encode('two'));
  await proc.stdin.close();
  expect(decoder.decode((await stdout.read()).value)).toBe('received:one two\n');
  expect(await proc.exit).toBe(0);
  expect((await stdout.read()).done).toBe(true);
  expect((await stderr.read()).done).toBe(true);
  expect(disconnects).toBe(0);
}, 60_000);

test('ProcessManager kills a registered streaming host binary', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let resolveExit!: (status: number) => void;
  let stdinClosed = false;
  pm.registerStreamingHostBinary('/bin/ssh', ({ stdin }) => {
    void stdin.getReader().read().then(({ done }) => { stdinClosed = done; });
    return {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill: () => { resolveExit(137); },
    };
  });

  const proc = await pm.spawn('/bin/ssh', [], { cwd: '/' });
  proc.kill();

  expect(await proc.exit).toBe(137);
  expect(stdinClosed).toBe(true);
}, 60_000);

test('ProcessManager settles and cleans up when a streaming host factory throws', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerStreamingHostBinary('/bin/fail', () => {
    throw new Error('startup failed');
  });

  const proc = await pm.spawn('/bin/fail', [], { cwd: '/' });

  expect(await proc.exit).toBe(1);
  expect(pm.activePids()).not.toContain(proc.pid);
  expect((await proc.stdout.getReader().read()).done).toBe(true);
  expect((await proc.stderr.getReader().read()).done).toBe(true);
}, 60_000);

test('ProcessManager applies output backpressure to an unread streaming host', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const encoder = new TextEncoder();
  let writesStarted = 0;
  let resolveExit!: (status: number) => void;
  pm.registerStreamingHostBinary('/bin/output', ({ stdout }) => {
    void (async () => {
      for (let i = 0; i < 128; i++) {
        writesStarted++;
        await stdout(encoder.encode('data'));
      }
    })();
    return {
      exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
      kill: () => { resolveExit(137); },
    };
  });

  const proc = await pm.spawn('/bin/output', [], { cwd: '/' });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  expect(writesStarted).toBe(2);

  proc.kill();
  expect(await proc.exit).toBe(137);
  expect(pm.activePids()).not.toContain(proc.pid);
  const stdout = proc.stdout.getReader();
  expect((await stdout.read()).value).toEqual(encoder.encode('data'));
  expect((await stdout.read()).done).toBe(true);
}, 60_000);

test('ProcessManager drains pending streaming-host output before resolving exit', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const encoder = new TextEncoder();
  pm.registerStreamingHostBinary('/bin/fast-exit', ({ stdout, stderr }) => {
    void stdout(encoder.encode('out-1'));
    void stdout(encoder.encode('out-2'));
    void stderr(encoder.encode('err-1'));
    return { exit: Promise.resolve(7), kill: () => {} };
  });

  const proc = await pm.spawn('/bin/fast-exit', [], { cwd: '/' });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return result;
      result += decoder.decode(value, { stream: true });
    }
  };

  expect(await Promise.all([read(proc.stdout), read(proc.stderr), proc.exit]))
    .toEqual(['out-1out-2', 'err-1', 7]);
}, 60_000);

test('ProcessManager resolves streaming-host exit before an unread output stream is consumed', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const encoder = new TextEncoder();
  pm.registerStreamingHostBinary('/bin/unread-output', ({ stdout, stderr }) => {
    void stdout(encoder.encode('out-1'));
    void stdout(encoder.encode('out-2'));
    void stdout(encoder.encode('out-3'));
    void stderr(encoder.encode('err-1'));
    void stderr(encoder.encode('err-2'));
    return { exit: Promise.resolve(23), kill: () => {} };
  });

  const proc = await pm.spawn('/bin/unread-output', [], { cwd: '/' });
  const status = await Promise.race([
    proc.exit,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('streaming-host exit timed out')), 250)),
  ]);
  const read = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let result = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return result;
      result += decoder.decode(value, { stream: true });
    }
  };

  expect(status).toBe(23);
  expect(await read(proc.stdout)).toBe('out-1out-2out-3');
  expect(await read(proc.stderr)).toBe('err-1err-2');
}, 60_000);

test('ProcessManager kills an unresolved streaming host factory without waiting for it', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let resolveFactory!: (process: { exit: Promise<number>; kill(): void }) => void;
  let lateKills = 0;
  pm.registerStreamingHostBinary('/bin/pending', () => new Promise((resolve) => { resolveFactory = resolve; }));

  const proc = await pm.spawn('/bin/pending', [], { cwd: '/' });
  proc.kill();

  expect(await proc.exit).toBe(137);
  expect(pm.activePids()).not.toContain(proc.pid);

  resolveFactory({ exit: Promise.resolve(0), kill: () => { lateKills++; } });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  expect(lateKills).toBe(1);
  expect(pm.activePids()).not.toContain(proc.pid);
}, 60_000);

test('ProcessManager applies input backpressure to an unread streaming host', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let resolveExit!: (status: number) => void;
  pm.registerStreamingHostBinary('/bin/input', () => ({
    exit: new Promise<number>((resolve) => { resolveExit = resolve; }),
    kill: () => { resolveExit(137); },
  }));

  const proc = await pm.spawn('/bin/input', [], { cwd: '/' });
  const firstWrite = proc.stdin.write(new Uint8Array([1]));
  const secondWrite = proc.stdin.write(new Uint8Array([2]));
  let firstSettled = false;
  let secondSettled = false;
  void firstWrite.then(() => { firstSettled = true; });
  void secondWrite.then(() => { secondSettled = true; });
  await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  expect(firstSettled).toBe(true);
  expect(secondSettled).toBe(false);

  proc.kill();
  expect(await secondWrite.then(() => true)).toBe(true);
  expect(await proc.exit).toBe(137);
  expect(pm.activePids()).not.toContain(proc.pid);
}, 60_000);

test('ProcessManager exposes and resolves a host-binary alias', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerHostBinary('/bin/hello', ({ args }) => ({ stdout: `${args.join(' ')}\n` }));
  pm.registerAlias('/bin/hi', '/bin/hello', ['hello']);

  expect(pm.listBinaries()).toContain('/bin/hi');
  expect(pm.hasBinary('/bin/hi')).toBe(true);
  const result = await pm.spawnSync('/bin/hi', ['dusk'], { cwd: '/' });

  expect(new TextDecoder().decode(result.stdout)).toBe('hello dusk\n');
}, 60_000);

test('ProcessManager executes an absolute script path containing dot segments', async () => {
  const backend = createMemoryBackend();
  await backend.mkdir('/home/amplify', { recursive: true });
  await backend.writeFile('/home/amplify/script', "process.stdout.write('normalized\\n');");
  const pm = new ProcessManager(backend);

  const result = await pm.spawnSync('/home/amplify/./script', [], { cwd: '/home/amplify' });

  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('normalized\n');
}, 60_000);

test('a refed timer keeps a spawned binary alive until it fires', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/timer', "setTimeout(() => process.stdout.write('timer-fired\\n'), 10);");

  const result = await pm.spawnSync('/bin/timer', [], { cwd: '/' });

  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('timer-fired\n');
}, 60_000);

test('an unrefed timer permits a spawned binary to exit', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/unref-timer', "setTimeout(() => process.stdout.write('should-not-fire\\n'), 100).unref();");

  const result = await pm.spawnSync('/bin/unref-timer', [], { cwd: '/' });

  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('');
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
