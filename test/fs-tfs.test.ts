import { test, expect, beforeEach, afterEach } from 'vitest';
import { createTfsBackend, createMemoryBackend } from '../src/host/fs-backend';

const clearOpfs = async (): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  // @ts-expect-error values() is available on OPFS dir handles in Chromium
  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
};

const writeOpfsText = async (name: string, content: string): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  const handle = await root.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(content);
  await writable.close();
};

beforeEach(clearOpfs);
afterEach(clearOpfs);

test('tfs backend initializes a fresh OPFS store without an unhandled JSON rejection', async () => {
  const rejections: unknown[] = [];
  const capture = (event: PromiseRejectionEvent): void => {
    rejections.push(event.reason);
    event.preventDefault();
  };
  window.addEventListener('unhandledrejection', capture);
  try {
    await createTfsBackend();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rejections).toEqual([]);
  } finally {
    window.removeEventListener('unhandledrejection', capture);
  }
});

test('memory backend round-trips', async () => {
  const fs = createMemoryBackend();
  await fs.mkdir('/app', { recursive: true });
  await fs.writeFile('/app/a.txt', 'hello');
  expect(await fs.readFile('/app/a.txt')).toBe('hello');
  expect(await fs.readdir('/app')).toEqual(['a.txt']);
  expect(await fs.exists('/app/a.txt')).toBe(true);
  expect((await fs.stat('/app/a.txt')).isFile).toBe(true);
  await fs.rename('/app/a.txt', '/app/b.txt');
  expect(await fs.exists('/app/b.txt')).toBe(true);
  await fs.rm('/app/b.txt');
  expect(await fs.exists('/app/b.txt')).toBe(false);
});

test('tfs backend round-trips against real OPFS', async () => {
  const fs = await createTfsBackend();
  await fs.mkdir('/app', { recursive: true });
  await fs.writeFile('/app/a.txt', 'hello tfs');
  expect(await fs.readFile('/app/a.txt')).toBe('hello tfs');
  expect(await fs.readdir('/app')).toContain('a.txt');
  expect(await fs.exists('/app/a.txt')).toBe(true);
  expect((await fs.stat('/app/a.txt')).isFile).toBe(true);
  await fs.rename('/app/a.txt', '/app/b.txt');
  expect(await fs.exists('/app/b.txt')).toBe(true);
  await fs.rm('/app/b.txt');
  expect(await fs.exists('/app/b.txt')).toBe(false);
}, 60_000);

test('tfs backend persists stable stat metadata across backend recreation', async () => {
  const root = `/metadata-${crypto.randomUUID()}`;
  const fs = await createTfsBackend();
  try {
    await fs.mkdir(root);
    const directory = await fs.stat(root);
    expect(directory).toMatchObject({ isFile: false, isDirectory: true, size: 0 });

    await fs.writeFile(`${root}/file.txt`, 'one');
    const initial = await fs.stat(`${root}/file.txt`);
    expect(await fs.stat(`${root}/file.txt`)).toEqual(initial);

    await fs.writeFile(`${root}/file.txt`, 'longer');
    const written = await fs.stat(`${root}/file.txt`);
    expect(written.size).toBe(6);
    expect(written.mtimeMs).toBeGreaterThan(initial.mtimeMs);

    await fs.rename(`${root}/file.txt`, `${root}/renamed.txt`);
    expect(await fs.stat(`${root}/renamed.txt`)).toEqual(written);

    const recreated = await createTfsBackend();
    expect(await recreated.stat(`${root}/renamed.txt`)).toEqual(written);
    expect(await recreated.readdir('/')).not.toContain('.dusk-metadata.json');
  } finally {
    await fs.rm(root, { recursive: true }).catch(() => {});
  }
}, 60_000);

test('TFS backends merge sequenced and concurrent metadata updates', async () => {
  const root = `/metadata-concurrency-${crypto.randomUUID()}`;
  const first = await createTfsBackend();
  const second = await createTfsBackend();

  await first.writeFile(`${root}/first.txt`, 'first');
  await second.writeFile(`${root}/second.txt`, 'second');
  await Promise.all([
    first.writeFile(`${root}/third.txt`, 'third'),
    second.writeFile(`${root}/fourth.txt`, 'fourth'),
  ]);

  const opfs = await navigator.storage.getDirectory();
  const sidecar = await opfs.getFileHandle('.dusk-metadata.json');
  const metadata = JSON.parse(await (await sidecar.getFile()).text()) as Record<string, unknown>;
  expect(Object.keys(metadata)).toEqual(expect.arrayContaining([
    root,
    `${root}/first.txt`,
    `${root}/second.txt`,
    `${root}/third.txt`,
    `${root}/fourth.txt`,
  ]));
}, 60_000);

test('TFS mutation rejects malformed metadata without overwriting the sidecar', async () => {
  const fs = await createTfsBackend();
  const malformed = '{"broken":';
  await writeOpfsText('.dusk-metadata.json', malformed);

  await expect(fs.writeFile('/malformed-sidecar.txt', 'content')).rejects.toThrow(SyntaxError);

  const root = await navigator.storage.getDirectory();
  const sidecar = await root.getFileHandle('.dusk-metadata.json');
  expect(await (await sidecar.getFile()).text()).toBe(malformed);
}, 60_000);

test('TFS initialization propagates a non-absence sidecar read failure', async () => {
  const root = await navigator.storage.getDirectory();
  await root.getDirectoryHandle('.dusk-metadata.json', { create: true });

  await expect(createTfsBackend()).rejects.toThrow();
  await expect(root.getDirectoryHandle('.dusk-metadata.json')).resolves.toBeDefined();
}, 60_000);

test('persistent TFS fails closed without Web Locks and does not hang', async () => {
  const ownDescriptor = Object.getOwnPropertyDescriptor(navigator, 'locks');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  try {
    const result = await Promise.race([
      createTfsBackend().then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 250)),
    ]);
    expect(result).not.toBe('timeout');
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain('Web Locks API');
  } finally {
    if (ownDescriptor) Object.defineProperty(navigator, 'locks', ownDescriptor);
    else delete (navigator as { locks?: LockManager }).locks;
  }
}, 60_000);
