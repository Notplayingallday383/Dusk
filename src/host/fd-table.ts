// DuskJS/src/host/fd-table.ts

export interface FDEntry {
  backendHandle: number;
  path: string;
  flags: number;
  position: number;     // current read/write offset
  appendOnly: boolean;
}

export interface FDTable {
  allocate(init: Omit<FDEntry, 'position'> & { position?: number }): number;
  release(fd: number): FDEntry | undefined;
  get(fd: number): FDEntry | undefined;
  closeAll(visit: (entry: FDEntry, fd: number) => void): void;
  size(): number;
}

const DEFAULT_MAX_OPEN = 1024;

export const createFDTable = (maxOpen: number = DEFAULT_MAX_OPEN): FDTable => {
  // Stdio reserves 0/1/2; user fds start at 3.
  const entries = new Map<number, FDEntry>();
  const freelist: number[] = [];
  let nextFd = 3;

  return {
    allocate(init) {
      if (entries.size + 3 >= maxOpen) {
        const e: Error & { code?: string } = new Error('EMFILE: too many open files');
        e.code = 'EMFILE';
        throw e;
      }
      const fd = freelist.length > 0 ? freelist.shift()! : nextFd++;
      entries.set(fd, {
        backendHandle: init.backendHandle,
        path: init.path,
        flags: init.flags,
        appendOnly: init.appendOnly,
        position: init.position ?? 0,
      });
      return fd;
    },
    release(fd) {
      const e = entries.get(fd);
      if (!e) return undefined;
      entries.delete(fd);
      // Reuse freed slot (lowest-first). Keep freelist sorted.
      freelist.push(fd);
      freelist.sort((a, b) => a - b);
      return e;
    },
    get(fd) { return entries.get(fd); },
    closeAll(visit) {
      for (const [fd, e] of entries) visit(e, fd);
      entries.clear();
      freelist.length = 0;
      nextFd = 3;
    },
    size() { return entries.size; },
  };
};
