import { createTfsBackend } from '../../src/host/fs-backend';

const tfsBackend = createTfsBackend();

export interface CompatWorkspaceSnapshotEntry {
  path: string;
  bytes: Uint8Array;
}

export interface CompatWorkspace {
  user: string;
  root: string;
  write(path: string, contents: string | Uint8Array): Promise<void>;
  snapshot(): Promise<CompatWorkspaceSnapshotEntry[]>;
  restore(snapshot: CompatWorkspaceSnapshotEntry[]): Promise<void>;
  cleanup(): Promise<void>;
}

const createWorkspaceRoot = async (user: string): Promise<void> => {
  const opfsRoot = await navigator.storage.getDirectory();
  const fixturesRoot = await opfsRoot.getDirectoryHandle('compat-fixtures', { create: true });
  await fixturesRoot.getDirectoryHandle(user, { create: true });
};

const removeWorkspaceRoot = async (user: string): Promise<void> => {
  const opfsRoot = await navigator.storage.getDirectory();
  const fixturesRoot = await opfsRoot.getDirectoryHandle('compat-fixtures');
  await fixturesRoot.removeEntry(user, { recursive: true });
};

const removeWorkspaceRootIfPresent = async (user: string): Promise<void> => {
  await removeWorkspaceRoot(user).catch((error: unknown) => {
    if (error instanceof DOMException && error.name === 'NotFoundError') return;
    throw error;
  });
};

const normalizePath = (path: string): string => {
  const normalized = path.replace(/^\/+/, '');
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..' || !part)) {
    throw new Error(`Invalid workspace path: ${path}`);
  }
  return normalized;
};

export const createCompatWorkspace = async (prefix: string): Promise<CompatWorkspace> => {
  const fs = await tfsBackend;
  const user = `${prefix.replace(/[^a-zA-Z0-9_-]/g, '-')}-${crypto.randomUUID()}`;
  const root = `/compat-fixtures/${user}`;
  await createWorkspaceRoot(user);

  const workspacePath = (path: string): string => `${root}/${normalizePath(path)}`;
  const snapshotRoot = async (snapshotRoot: string): Promise<CompatWorkspaceSnapshotEntry[]> => {
    const entries: CompatWorkspaceSnapshotEntry[] = [];
    const visit = async (path: string): Promise<void> => {
      for (const name of (await fs.readdir(path)).sort()) {
        const child = `${path}/${name}`;
        const stat = await fs.stat(child);
        if (stat.isDirectory) await visit(child);
        else entries.push({ path: child.slice(snapshotRoot.length + 1), bytes: await fs.readFileBytes(child) });
      }
    };
    await visit(snapshotRoot);
    return entries;
  };
  const writeEntries = async (destinationRoot: string, entries: CompatWorkspaceSnapshotEntry[]): Promise<void> => {
    for (const entry of entries) {
      await fs.writeFileBytes(`${destinationRoot}/${normalizePath(entry.path)}`, entry.bytes);
    }
  };
  const snapshot = async (): Promise<CompatWorkspaceSnapshotEntry[]> => snapshotRoot(root);

  return {
    user,
    root,
    write: async (path, contents) => {
      const destination = workspacePath(path);
      if (typeof contents === 'string') await fs.writeFile(destination, contents);
      else await fs.writeFileBytes(destination, contents);
    },
    snapshot,
    restore: async (entries) => {
      const stagingUser = `${user}-restore-${crypto.randomUUID()}`;
      const stagingRoot = `/compat-fixtures/${stagingUser}`;
      await createWorkspaceRoot(stagingUser);
      try {
        await writeEntries(stagingRoot, entries);
        const original = await snapshot();
        const staged = await snapshotRoot(stagingRoot);
        await removeWorkspaceRoot(user);
        try {
          await createWorkspaceRoot(user);
          await writeEntries(root, staged);
        } catch (error) {
          await removeWorkspaceRootIfPresent(user);
          await createWorkspaceRoot(user);
          await writeEntries(root, original);
          throw error;
        }
      } finally {
        await removeWorkspaceRootIfPresent(stagingUser);
      }
    },
    cleanup: async () => {
      await removeWorkspaceRootIfPresent(user);
    },
  };
};
