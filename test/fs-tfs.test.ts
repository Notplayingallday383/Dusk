import { test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { createTfsBackend, createMemoryBackend } from '../src/host/fs-backend';

const clearOpfs = async (): Promise<void> => {
  const root = await navigator.storage.getDirectory();
  // @ts-expect-error values() is available on OPFS dir handles in Chromium
  for await (const [name] of root.entries()) {
    await root.removeEntry(name, { recursive: true }).catch(() => {});
  }
};

const isTfsVendorJsonError = (reason: unknown): boolean => {
  if (!(reason instanceof Error)) return false;
  if (reason.name !== 'SyntaxError') return false;
  if (!reason.message.includes('JSON')) return false;
  const stack = reason.stack ?? '';
  return stack.includes('@terbiumos/tfs');
};

const swallowTfsVendorRejection = (event: PromiseRejectionEvent): void => {
  if (isTfsVendorJsonError(event.reason)) event.preventDefault();
};

beforeAll(() => { window.addEventListener('unhandledrejection', swallowTfsVendorRejection); });
afterAll(() => { window.removeEventListener('unhandledrejection', swallowTfsVendorRejection); });

beforeEach(clearOpfs);
afterEach(clearOpfs);

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
