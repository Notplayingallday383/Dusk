interface OpfsDirHandle {
  kind: 'directory';
  entries(): AsyncIterableIterator<[string, OpfsDirHandle | OpfsFileHandle]>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
}
interface OpfsFileHandle {
  kind: 'file';
}

const getRoot = async (): Promise<OpfsDirHandle> =>
  (await navigator.storage.getDirectory()) as unknown as OpfsDirHandle;

const walkDir = async (dir: OpfsDirHandle, prefix: string): Promise<string[]> => {
  const entries: [string, OpfsDirHandle | OpfsFileHandle][] = [];
  for await (const entry of dir.entries()) entries.push(entry);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const lines: string[] = [];
  for (const [name, handle] of entries) {
    if (handle.kind === 'directory') {
      lines.push(prefix + name + '/');
      lines.push(...(await walkDir(handle as OpfsDirHandle, prefix + '  ')));
    } else {
      lines.push(prefix + name);
    }
  }
  return lines;
};

export const walkOpfs = async (): Promise<string> => {
  const root = await getRoot();
  const lines = await walkDir(root, '');
  return lines.length > 0 ? lines.join('\n') : '(empty)';
};

export const clearOpfs = async (): Promise<void> => {
  const root = await getRoot();
  const names: string[] = [];
  for await (const [name] of root.entries()) names.push(name);
  for (const name of names) await root.removeEntry(name, { recursive: true });
};
