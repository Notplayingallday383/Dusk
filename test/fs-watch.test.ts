import { expect, test } from 'vitest';
import { createMemoryBackend, createTfsBackend, O_CREAT, O_RDWR, type FSBackend } from '../src/host/fs-backend';
import { createLayoutBackend } from '../src/host/fs-layout';
import { ProcessManager } from '../src/host/process-manager';
import { createNativeEngine } from '../src/host/engine-instance';
import { createFuncs } from '../src/host/funcs';

type Mutation = { type: 'write' | 'mkdir' | 'rename' | 'rm'; path: string; previousPath?: string };

const waitForDeadline = async <T>(promise: Promise<T>, description: string, timeoutMs: number): Promise<T> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(description)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const waitForStdout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (output: string) => boolean,
  description: string,
  timeoutMs = 5_000,
): Promise<string> => {
  const decoder = new TextDecoder();
  let output = '';
  const deadline = Date.now() + timeoutMs;
  while (!predicate(output)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`${description}; output: ${output}`);
    const result = await waitForDeadline(reader.read(), `${description}; output: ${output}`, remaining);
    if (result.done) throw new Error(`${description}; stdout closed; output: ${output}`);
    output += decoder.decode(result.value, { stream: true });
  }
  return output;
};

const waitForExit = (exit: Promise<number>, description: string, timeoutMs = 500): Promise<number> =>
  waitForDeadline(exit, description, timeoutMs);

const exerciseBackendMutations = async (fs: FSBackend, root: string): Promise<void> => {
  const events: Mutation[] = [];
  const unsubscribe = fs.subscribe((event) => events.push(event));
  try {
    await fs.mkdir(root);
    await fs.writeFile(`${root}/source.txt`, 'source');
    await fs.rename(`${root}/source.txt`, `${root}/renamed.txt`);
    await fs.rm(`${root}/renamed.txt`);

    expect(events).toEqual([
      { type: 'mkdir', path: root },
      { type: 'write', path: `${root}/source.txt` },
      { type: 'rename', path: `${root}/renamed.txt`, previousPath: `${root}/source.txt` },
      { type: 'rm', path: `${root}/renamed.txt` },
    ]);
  } finally {
    unsubscribe();
  }
  await fs.writeFile(`${root}/after-unsubscribe.txt`, 'ignored');
  expect(events).toHaveLength(4);
};

test('memory backend emits ordered normalized mutations and stops after unsubscribe', async () => {
  await exerciseBackendMutations(createMemoryBackend(), '/fs-watch-memory');
});

test('memory backend renames a directory tree', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/source/nested', { recursive: true });
  await fs.writeFile('/source/nested/file.txt', 'contents');

  await fs.rename('/source', '/destination');

  await expect(fs.exists('/source')).resolves.toBe(false);
  await expect(fs.readFile('/destination/nested/file.txt')).resolves.toBe('contents');
});

test('memory backend reports stable stat metadata and updates it on mutations', async () => {
  const fs = createMemoryBackend();
  await fs.writeFile('/metadata.txt', 'one');

  const initial = await fs.stat('/metadata.txt');
  const repeated = await fs.stat('/metadata.txt');
  expect(repeated).toEqual(initial);
  expect(initial).toMatchObject({ isFile: true, isDirectory: false, size: 3 });

  await fs.writeFile('/metadata.txt', 'longer');
  const written = await fs.stat('/metadata.txt');
  expect(written.size).toBe(6);
  expect(written.mtimeMs).toBeGreaterThan(initial.mtimeMs);

  await fs.mkdir('/metadata-directory');
  const directory = await fs.stat('/metadata-directory');
  expect(directory).toMatchObject({ isFile: false, isDirectory: true, size: 0 });

  await fs.rename('/metadata.txt', '/renamed.txt');
  expect(await fs.stat('/renamed.txt')).toEqual(written);
});

test('fs.watch receives host backend writes without waiting for its polling interval', async () => {
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  pm.registerBinary('/bin/watch-host-write', `
    const fs = require('fs');
    const watcher = fs.watch('/watched.txt', (event, filename) => {
      process.stdout.write(event + ':' + filename);
      watcher.close();
    });
    process.stdout.write('ready');
  `);
  await backend.writeFile('/watched.txt', 'before');
  const proc = await pm.spawn('/bin/watch-host-write');
  const reader = proc.stdout.getReader();
  const readyOutput = await waitForStdout(reader, (output) => output.includes('ready'), 'fs.watch did not become ready');
  await backend.writeFile('/watched.txt', 'after');
  const eventOutput = readyOutput + await waitForStdout(reader, (output) => output.includes('change:watched.txt'), 'fs.watch did not receive the host mutation promptly');

  expect(eventOutput).toContain('change:watched.txt');
  await expect(waitForExit(proc.exit, 'fs.watch did not exit')).resolves.toBe(0);
}, 60_000);

test('default ESM node:fs import receives host watcher mutations', async () => {
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  await backend.writeFile('/default-esm-watch.txt', 'before');
  const proc = await pm.spawn('/bin/node', [
    '--input-type=module',
    '-e',
    '(async () => { const fs = (await import("node:fs")).default; const watcher = fs.watch("/default-esm-watch.txt", (event, filename) => { process.stdout.write(event + ":" + filename); watcher.close(); }); process.stdout.write("ready"); })().catch((error) => { console.error(error.stack ?? error); process.exit(1); })',
  ]);
  const reader = proc.stdout.getReader();
  const readyOutput = await waitForStdout(reader, (output) => output.includes('ready'), 'default ESM fs.watch did not become ready');
  await backend.writeFile('/default-esm-watch.txt', 'after');
  const output = readyOutput + await waitForStdout(reader, (text) => text.includes('change:default-esm-watch.txt'), 'default ESM fs.watch did not receive the host mutation');

  expect(output).toContain('change:default-esm-watch.txt');
  await expect(waitForExit(proc.exit, 'default ESM fs.watch did not exit')).resolves.toBe(0);
}, 60_000);

test('static default fs import receives host watcher mutations', async () => {
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  await backend.writeFile('/static-default-watch.txt', 'before');
  await backend.writeFile('/static-default-watch.mjs', 'import fs from "fs"; const watcher = fs.watch("/static-default-watch.txt", (event, filename) => { process.stdout.write(event + ":" + filename); watcher.close(); }); process.stdout.write("ready");\n');
  const proc = await pm.spawn('/bin/node', [
    '--input-type=module',
    '-e',
    '(async () => { await import("/static-default-watch.mjs"); })().catch((error) => { console.error(error.stack ?? error); process.exit(1); })',
  ]);
  const reader = proc.stdout.getReader();
  const readyOutput = await waitForStdout(reader, (output) => output.includes('ready'), 'static default fs.watch did not become ready', 15_000);
  await backend.writeFile('/static-default-watch.txt', 'after');
  const output = readyOutput + await waitForStdout(reader, (text) => text.includes('change:static-default-watch.txt'), 'static default fs.watch did not receive the host mutation');

  expect(output).toContain('change:static-default-watch.txt');
  await expect(waitForExit(proc.exit, 'static default fs.watch did not exit')).resolves.toBe(0);
}, 60_000);

test('recursive fs.watch receives nested host backend writes', async () => {
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  pm.registerBinary('/bin/watch-recursive-host-write', `
    const fs = require('fs');
    const watcher = fs.watch('/watched', { recursive: true }, (event, filename) => {
      process.stdout.write(event + ':' + filename);
      watcher.close();
    });
    process.stdout.write('ready');
  `);
  await backend.mkdir('/watched/nested', { recursive: true });
  const proc = await pm.spawn('/bin/watch-recursive-host-write');
  const reader = proc.stdout.getReader();
  const readyOutput = await waitForStdout(reader, (output) => output.includes('ready'), 'recursive fs.watch did not become ready');
  await backend.writeFile('/watched/nested/file.txt', 'after');
  const eventOutput = readyOutput + await waitForStdout(reader, (output) => output.includes('change:nested/file.txt'), 'recursive fs.watch did not receive the host mutation');

  expect(eventOutput).toContain('change:nested/file.txt');
  await expect(waitForExit(proc.exit, 'recursive fs.watch did not exit')).resolves.toBe(0);
}, 60_000);

test('host fs.watch delivers close before clearing listeners and unref does not retain the process', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/watch-close', `
    const fs = require('fs');
    const watcher = fs.watch('/close.txt');
    watcher.on('close', () => process.stdout.write('closed'));
    watcher.close();
  `);
  pm.registerBinary('/bin/watch-unref', `
    require('fs').watch('/unref.txt').unref();
  `);

  const closeProcess = await pm.spawn('/bin/watch-close');
  const closeReader = closeProcess.stdout.getReader();
  const closeResult = await closeReader.read();
  expect(new TextDecoder().decode(closeResult.value)).toBe('closed');
  await expect(closeProcess.exit).resolves.toBe(0);

  const unrefProcess = await pm.spawn('/bin/watch-unref');
  await expect(waitForExit(unrefProcess.exit, 'unrefed fs.watch retained the process')).resolves.toBe(0);
}, 60_000);

test('host fs.watch coalesces rapid writes into one notification per path and event turn', async () => {
  const backend = createMemoryBackend();
  const pm = new ProcessManager(backend);
  pm.registerBinary('/bin/watch-coalesce', `
    const fs = require('fs');
    let count = 0;
    const watcher = fs.watch('/coalesce.txt', () => {
      count++;
      setTimeout(() => { process.stdout.write(String(count)); watcher.close(); }, 25);
    });
    process.stdout.write('ready');
  `);
  await backend.writeFile('/coalesce.txt', 'before');
  const proc = await pm.spawn('/bin/watch-coalesce');
  const reader = proc.stdout.getReader();
  const readyOutput = await waitForStdout(reader, (output) => output.includes('ready'), 'fs.watch coalescing did not become ready');
  await backend.writeFile('/coalesce.txt', 'first');
  await backend.writeFile('/coalesce.txt', 'second');
  const output = readyOutput + await waitForStdout(reader, (text) => text.includes('1') || text.includes('2'), 'fs.watch coalescing did not produce output');
  expect(output).toBe('ready1');
  await expect(waitForExit(proc.exit, 'fs.watch coalescing did not exit')).resolves.toBe(0);
}, 60_000);

test('polling fs.watch does not report unchanged stats without mtimeMs', async () => {
  const backend = createMemoryBackend();
  const output: string[] = [];
  await backend.writeFile('/unchanged.txt', 'contents');
  const engine = await createNativeEngine(1, createFuncs(backend, (text) => output.push(text)));
  await engine.run(`
    const watcher = require('fs').watch('/unchanged.txt', { interval: 20 });
    watcher.on('change', () => console.log('changed'));
    setTimeout(() => watcher.close(), 80);
  `);
  await new Promise((resolve) => setTimeout(resolve, 120));
  await engine.terminate();
  expect(output.join('')).not.toContain('changed');
}, 60_000);

test('polling fs.watchFile reports a host mutation with backend stat metadata', async () => {
  const backend = createMemoryBackend();
  const output: string[] = [];
  await backend.writeFile('/watch-file.txt', 'before');
  const engine = await createNativeEngine(1, createFuncs(backend, (text) => output.push(text)));
  await engine.run(`
    const fs = require('fs');
    fs.watchFile('/watch-file.txt', { interval: 20 }, (curr, prev) => {
      console.log(curr.size + ':' + prev.size + ':' + (curr.mtimeMs > prev.mtimeMs));
      fs.unwatchFile('/watch-file.txt');
    });
  `);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await backend.writeFile('/watch-file.txt', 'after!');
  await new Promise((resolve) => setTimeout(resolve, 100));
  await engine.terminate();

  expect(output.join('')).toBe('6:6:true\n');
}, 60_000);

test('guest Stats does not fabricate timestamps when a backend omits them', async () => {
  const memory = createMemoryBackend();
  await memory.writeFile('/legacy-stat.txt', 'contents');
  const backend = {
    ...memory,
    stat: async (path: string) => {
      const { size: _size, mtimeMs: _mtimeMs, atimeMs: _atimeMs, ctimeMs: _ctimeMs, birthtimeMs: _birthtimeMs, ...legacy } = await memory.stat(path);
      return legacy;
    },
  } as FSBackend;
  const output: string[] = [];
  const engine = await createNativeEngine(1, createFuncs(backend, (text) => output.push(text)));
  await engine.run(`
    const stat = require('fs').statSync('/legacy-stat.txt');
    console.log(stat.size + ':' + stat.mtimeMs + ':' + stat.atimeMs);
  `);
  await engine.terminate();

  expect(output.join('')).toBe('0:0:0\n');
}, 60_000);

test('guest fs.promises.readdir returns directory entries when requested', async () => {
  const backend = createMemoryBackend();
  const output: string[] = [];
  await backend.mkdir('/entries');
  await backend.writeFile('/entries/file.txt', 'contents');
  await backend.mkdir('/entries/directory');
  const engine = await createNativeEngine(1, createFuncs(backend, (text) => output.push(text)));
  await engine.run(`
    require('fs').promises.readdir('/entries', { withFileTypes: true }).then((entries) => {
      console.log(entries.map((entry) => entry.name + ':' + entry.isFile() + ':' + entry.isDirectory()).sort().join(','));
    });
  `);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await engine.terminate();

  expect(output.join('')).toBe('directory:false:true,file.txt:true:false\n');
}, 60_000);

test('recursive polling fs.watch reports a newly added child once', async () => {
  const backend = createMemoryBackend();
  const output: string[] = [];
  await backend.mkdir('/recursive');
  const engine = await createNativeEngine(1, createFuncs(backend, (text) => output.push(text)));
  await engine.run(`
    const watcher = require('fs').watch('/recursive', { recursive: true, interval: 20 });
    watcher.on('rename', (_event, name) => console.log(name));
    setTimeout(() => watcher.close(), 120);
  `);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await backend.writeFile('/recursive/child.txt', 'child');
  await new Promise((resolve) => setTimeout(resolve, 140));
  await engine.terminate();
  expect(output.filter((text) => text.includes('child.txt'))).toHaveLength(1);
}, 60_000);

test('recursive polling fs.watch drops descendant snapshots when a subtree is deleted', async () => {
  const backend = createMemoryBackend();
  const output: string[] = [];
  await backend.mkdir('/tree/branch', { recursive: true });
  await backend.writeFile('/tree/branch/leaf.txt', 'before');
  const engine = await createNativeEngine(1, createFuncs(backend, (text) => output.push(text)));
  await engine.run(`
    const watcher = require('fs').watch('/tree', { recursive: true, interval: 20 });
    watcher.on('rename', (_event, name) => console.log(name));
    setTimeout(() => watcher.close(), 220);
  `);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await backend.rm('/tree/branch', { recursive: true });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await backend.mkdir('/tree/branch');
  await backend.writeFile('/tree/branch/leaf.txt', 'after');
  await new Promise((resolve) => setTimeout(resolve, 180));
  await engine.terminate();
  expect(output.filter((text) => text.includes('branch\n'))).toHaveLength(2);
}, 60_000);

test('TFS backend emits ordered normalized mutations and stops after unsubscribe', async () => {
  const fs = await createTfsBackend();
  const root = `/fs-watch-tfs-${crypto.randomUUID()}`;
  try {
    await exerciseBackendMutations(fs, root);
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => {});
  }
}, 60_000);

test('memory backend canonicalizes paths and listener errors do not reject successful mutations', async () => {
  const fs = createMemoryBackend();
  const events: Mutation[] = [];
  const removeThrowingListener = fs.subscribe(() => { throw new Error('listener failure'); });
  const unsubscribe = fs.subscribe((event) => events.push(event));
  try {
    await expect(fs.mkdir('/canonical')).resolves.toBeUndefined();
    await expect(fs.writeFile('/canonical/./file.txt', 'contents')).resolves.toBeUndefined();
    expect(events).toEqual([
      { type: 'mkdir', path: '/canonical' },
      { type: 'write', path: '/canonical/file.txt' },
    ]);
  } finally {
    removeThrowingListener();
    unsubscribe();
  }
});

test('memory backend emits fd write and truncate mutations when they are persisted', async () => {
  const fs = createMemoryBackend();
  const events: Mutation[] = [];
  const unsubscribe = fs.subscribe((event) => events.push(event));
  try {
    const { handle } = await fs.openHandle('/memory-fd.txt', O_CREAT | O_RDWR);
    await fs.writeHandle(handle, new TextEncoder().encode('contents'), 0);
    await fs.ftruncateHandle(handle, 3);
    await fs.fsyncHandle(handle);
    await fs.closeHandle(handle);
    expect(events).toEqual([
      { type: 'write', path: '/memory-fd.txt' },
      { type: 'write', path: '/memory-fd.txt' },
      { type: 'write', path: '/memory-fd.txt' },
    ]);
  } finally {
    unsubscribe();
  }
});

test('TFS backend emits fd mutations only when dirty contents are persisted', async () => {
  const fs = await createTfsBackend();
  const root = `/fs-watch-tfs-fd-${crypto.randomUUID()}`;
  const events: Mutation[] = [];
  const unsubscribe = fs.subscribe((event) => events.push(event));
  try {
    const { handle } = await fs.openHandle(`${root}.txt`, O_CREAT | O_RDWR);
    await fs.writeHandle(handle, new TextEncoder().encode('contents'), 0);
    await fs.ftruncateHandle(handle, 3);
    expect(events).toEqual([{ type: 'write', path: `${root}.txt` }]);
    await fs.fsyncHandle(handle);
    await fs.writeHandle(handle, new TextEncoder().encode('!'), 3);
    await fs.closeHandle(handle);
    expect(events).toEqual([
      { type: 'write', path: `${root}.txt` },
      { type: 'write', path: `${root}.txt` },
      { type: 'write', path: `${root}.txt` },
    ]);
  } finally {
    unsubscribe();
    await fs.rm(`${root}.txt`).catch(() => {});
  }
}, 60_000);

test('layout forwards persistent-home and ephemeral mutations as absolute virtual paths', async () => {
  const persistent = createMemoryBackend();
  const ephemeral = createMemoryBackend();
  const layout = await createLayoutBackend({
    persistent,
    ephemeral,
    processManager: new ProcessManager(ephemeral),
    user: 'watcher',
    hostname: 'dusk',
  });
  const events: Mutation[] = [];
  const unsubscribe = layout.subscribe((event) => events.push(event));
  try {
    await layout.mkdir('/home/watcher/project');
    await layout.writeFile('/home/watcher/project/app.ts', 'export {};');
    await layout.rename('/home/watcher/project/app.ts', '/home/watcher/project/main.ts');
    await layout.rm('/home/watcher/project/main.ts');
    await layout.writeFile('/tmp/ephemeral.txt', 'temporary');

    expect(events).toEqual([
      { type: 'mkdir', path: '/home/watcher/project' },
      { type: 'write', path: '/home/watcher/project/app.ts' },
      { type: 'rename', path: '/home/watcher/project/main.ts', previousPath: '/home/watcher/project/app.ts' },
      { type: 'rm', path: '/home/watcher/project/main.ts' },
      { type: 'write', path: '/tmp/ephemeral.txt' },
    ]);
  } finally {
    unsubscribe();
  }
  await layout.writeFile('/home/watcher/project/after-unsubscribe.ts', 'ignored');
  await layout.writeFile('/tmp/after-unsubscribe.txt', 'ignored');
  expect(events).toHaveLength(5);
});

test('layout synthetic mounts return stable metadata', async () => {
  const ephemeral = createMemoryBackend();
  const layout = await createLayoutBackend({
    persistent: createMemoryBackend(),
    ephemeral,
    processManager: new ProcessManager(ephemeral),
    user: 'metadata',
    hostname: 'dusk',
  });

  expect(await layout.stat('/proc')).toEqual({
    isFile: false,
    isDirectory: true,
    size: 0,
    mtimeMs: 0,
    atimeMs: 0,
    ctimeMs: 0,
    birthtimeMs: 0,
  });
});

test('layout routes persistent-home handle operations to persistent storage', async () => {
  const persistent = createMemoryBackend();
  const ephemeral = createMemoryBackend();
  const layout = await createLayoutBackend({
    persistent,
    ephemeral,
    processManager: new ProcessManager(ephemeral),
    user: 'watcher',
    hostname: 'dusk',
  });

  const { handle } = await layout.openHandle('/home/watcher/handle.txt', O_CREAT | O_RDWR);
  await layout.writeHandle(handle, new TextEncoder().encode('persistent'), 0);
  const read = await layout.readHandle(handle, 10, 0);
  await layout.closeHandle(handle);

  expect(new TextDecoder().decode(read.bytes)).toBe('persistent');
  await expect(persistent.readFile('/handle.txt')).resolves.toBe('persistent');
  await expect(ephemeral.exists('/home/watcher/handle.txt')).resolves.toBe(false);
});

test('layout persists /project while leaving /tmp and arbitrary root paths ephemeral', async () => {
  const persistent = createMemoryBackend();
  const ephemeral = createMemoryBackend();
  const layout = await createLayoutBackend({
    persistent,
    ephemeral,
    processManager: new ProcessManager(ephemeral),
    user: 'watcher',
    hostname: 'dusk',
  });

  await layout.writeFile('/project/package.json', '{"name":"app"}\n');
  await layout.writeFile('/tmp/session.txt', 'temporary');
  await layout.writeFile('/scratch.txt', 'temporary');

  await expect(persistent.readFile('/project/package.json')).resolves.toBe('{"name":"app"}\n');
  await expect(ephemeral.exists('/project/package.json')).resolves.toBe(false);
  await expect(ephemeral.readFile('/tmp/session.txt')).resolves.toBe('temporary');
  await expect(ephemeral.readFile('/scratch.txt')).resolves.toBe('temporary');
  await expect(persistent.exists('/tmp/session.txt')).resolves.toBe(false);
  await expect(persistent.exists('/scratch.txt')).resolves.toBe(false);
});
