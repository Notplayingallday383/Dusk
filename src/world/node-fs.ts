declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const call = (f: string, extra: Record<string, unknown>): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

type Cb = (err: Error | null, result?: unknown) => void;

const defer = (fn: () => void): void => { void Promise.resolve().then(fn); };

const cbOp = (run: () => unknown, cb?: Cb): void => {
  defer(() => {
    try { const r = run(); cb?.(null, r); }
    catch (e) { cb?.(e instanceof Error ? e : new Error(String(e))); }
  });
};

const promiseOp = <T>(run: () => T): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    defer(() => {
      try { resolve(run()); }
      catch (e) { reject(e instanceof Error ? e : new Error(String(e))); }
    });
  });

export const nodeFs = {
  readFile: (path: string, cb?: Cb): void => cbOp(() => call('fs.readFile', { path }), cb),
  writeFile: (path: string, data: string, cb?: Cb): void => cbOp(() => call('fs.writeFile', { path, data }), cb),
  readdir: (path: string, cb?: Cb): void => cbOp(() => call('fs.readdir', { path }), cb),
  mkdir: (path: string, optsOrCb?: { recursive?: boolean } | Cb, cb?: Cb): void => {
    const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    cbOp(() => call('fs.mkdir', { path, recursive: Boolean(opts?.recursive) }), callback);
  },
  rm: (path: string, optsOrCb?: { recursive?: boolean } | Cb, cb?: Cb): void => {
    const opts = typeof optsOrCb === 'function' ? undefined : optsOrCb;
    const callback = typeof optsOrCb === 'function' ? optsOrCb : cb;
    cbOp(() => call('fs.rm', { path, recursive: Boolean(opts?.recursive) }), callback);
  },
  exists: (path: string, cb?: (exists: boolean) => void): void => {
    defer(() => { try { cb?.(call('fs.exists', { path }) as boolean); } catch { cb?.(false); } });
  },
  stat: (path: string, cb?: Cb): void => cbOp(() => call('fs.stat', { path }), cb),
  rename: (from: string, to: string, cb?: Cb): void => cbOp(() => call('fs.rename', { from, to }), cb),
  promises: {
    readFile: (path: string): Promise<string> => promiseOp(() => call('fs.readFile', { path }) as string),
    writeFile: (path: string, data: string): Promise<void> => promiseOp(() => { call('fs.writeFile', { path, data }); }),
    readdir: (path: string): Promise<string[]> => promiseOp(() => call('fs.readdir', { path }) as string[]),
    mkdir: (path: string, opts?: { recursive?: boolean }): Promise<void> => promiseOp(() => { call('fs.mkdir', { path, recursive: Boolean(opts?.recursive) }); }),
    rm: (path: string, opts?: { recursive?: boolean }): Promise<void> => promiseOp(() => { call('fs.rm', { path, recursive: Boolean(opts?.recursive) }); }),
    stat: (path: string): Promise<{ isFile: boolean; isDirectory: boolean }> => promiseOp(() => call('fs.stat', { path }) as { isFile: boolean; isDirectory: boolean }),
    rename: (from: string, to: string): Promise<void> => promiseOp(() => { call('fs.rename', { from, to }); }),
  },
};
