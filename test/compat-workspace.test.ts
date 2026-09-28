import { expect, test } from 'vitest';
import { createCompatWorkspace } from './helpers/compat-workspace';

const rootExists = async (root: string): Promise<boolean> => {
  const segments = root.split('/').filter(Boolean);
  let directory = await navigator.storage.getDirectory();
  try {
    for (const segment of segments) directory = await directory.getDirectoryHandle(segment);
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'NotFoundError') return false;
    throw error;
  }
};

const cleanupWorkspaces = async (...workspaces: Array<Awaited<ReturnType<typeof createCompatWorkspace>> | undefined>): Promise<void> => {
  const results = await Promise.allSettled(workspaces.map(async (workspace) => workspace?.cleanup()));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (failure) throw failure.reason;
};

test('allocates isolated user homes below unique compatibility fixture roots', async () => {
  let first: Awaited<ReturnType<typeof createCompatWorkspace>> | undefined;
  let second: Awaited<ReturnType<typeof createCompatWorkspace>> | undefined;

  try {
    first = await createCompatWorkspace('vite');
    second = await createCompatWorkspace('vite');
    expect(first.user).not.toBe(second.user);
    expect(`/home/${first.user}`).not.toBe(`/home/${second.user}`);
    expect(first.root).toMatch(/^\/compat-fixtures\//);
    expect(second.root).toMatch(/^\/compat-fixtures\//);
    expect(first.root).not.toBe(second.root);
    expect(await rootExists(first.root)).toBe(true);
    expect(await rootExists(second.root)).toBe(true);
  } finally {
    await cleanupWorkspaces(first, second);
  }
}, 60_000);

test('restores a recursive workspace snapshot after mutation', async () => {
  const workspace = await createCompatWorkspace('snapshot');

  try {
    await workspace.write('src/main.ts', 'export const value = 1;\n');
    await workspace.write('public/index.html', '<main>first</main>\n');
    const snapshot = await workspace.snapshot();

    await workspace.write('src/main.ts', 'export const value = 2;\n');
    await workspace.write('new-file.txt', 'temporary\n');
    await workspace.restore(snapshot);

    expect(await workspace.snapshot()).toEqual(snapshot);
  } finally {
    await workspace.cleanup();
  }
}, 60_000);

test('leaves the original workspace intact when restore staging fails', async () => {
  const workspace = await createCompatWorkspace('restore-failure');

  try {
    await workspace.write('preserved.txt', 'original\n');
    const original = await workspace.snapshot();

    await expect(workspace.restore([
      { path: '../invalid.txt', bytes: new TextEncoder().encode('invalid\n') },
      ...original,
    ])).rejects.toThrow('Invalid workspace path');

    expect(await workspace.snapshot()).toEqual(original);
  } finally {
    await cleanupWorkspaces(workspace);
  }
}, 60_000);

test('cleanup removes only its workspace without clearing sibling OPFS fixtures', async () => {
  let first: Awaited<ReturnType<typeof createCompatWorkspace>> | undefined;
  let second: Awaited<ReturnType<typeof createCompatWorkspace>> | undefined;

  try {
    first = await createCompatWorkspace('cleanup');
    second = await createCompatWorkspace('cleanup');
    await first.write('first.txt', 'remove me');
    await second.write('second.txt', 'keep me');

    await first.cleanup();

    expect(await rootExists(first.root)).toBe(false);
    expect(await rootExists(second.root)).toBe(true);
    expect(await second.snapshot()).toEqual([
      { path: 'second.txt', bytes: new TextEncoder().encode('keep me') },
    ]);
  } finally {
    await cleanupWorkspaces(first, second);
  }
}, 60_000);
