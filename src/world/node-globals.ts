declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

export const installNodeGlobals = (): void => {
  const g = globalThis as Record<string, unknown>;
  const call = (f: string, extra: Record<string, unknown> = {}): unknown => {
    const r = ipc.send({ f, ...extra });
    if (r.error) throw new Error(r.error);
    return r.value;
  };
  g['console'] = {
    log: (...args: unknown[]) => call('console.log', { args }),
    error: (...args: unknown[]) => call('console.error', { args }),
  };
  g['process'] = {
    cwd: () => call('process.cwd'),
    env: {},
    argv: ['node'],
    platform: 'linux',
  };
  g['__fs'] = {
    readFile: (path: string) => call('fs.readFile', { path }),
    writeFile: (path: string, data: string) => call('fs.writeFile', { path, data }),
    readdir: (path: string) => call('fs.readdir', { path }),
    mkdir: (path: string, recursive: boolean) => call('fs.mkdir', { path, recursive }),
    rm: (path: string) => call('fs.rm', { path }),
    exists: (path: string) => call('fs.exists', { path }),
    stat: (path: string) => call('fs.stat', { path }),
    rename: (from: string, to: string) => call('fs.rename', { from, to }),
  };
};
