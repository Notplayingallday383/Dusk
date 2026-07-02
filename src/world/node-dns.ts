// node:dns — stub. Most code only needs lookup() not to throw at module load.

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const __call = (f: string, extra: Record<string, unknown> = {}): unknown => {
  const r = ipc.send({ f, ...extra });
  if (r.error) throw new Error(r.error);
  return r.value;
};

type LookupCallback = (err: Error | null, address: string, family: number) => void;

export const lookup = (hostname: string, optsOrCb: unknown, maybeCb?: LookupCallback): void => {
  let cb: LookupCallback | undefined;
  let family = 0;
  if (typeof optsOrCb === 'function') cb = optsOrCb as LookupCallback;
  else if (optsOrCb && typeof optsOrCb === 'object') {
    family = ((optsOrCb as { family?: number }).family) ?? 0;
    cb = maybeCb;
  }
  if (!cb) throw new TypeError('callback required');
  Promise.resolve().then(() => {
    try {
      const addr = __call('dns.lookup', { hostname, family }) as string | undefined;
      if (addr) cb!(null, addr, addr.includes(':') ? 6 : 4);
      else cb!(null, '127.0.0.1', 4);
    } catch (e) {
      cb!(e as Error, '', 0);
    }
  });
};

export const resolve4 = (hostname: string, cb: (err: Error | null, addrs: string[]) => void): void => {
  lookup(hostname, { family: 4 }, (err, addr) => {
    if (err) cb(err, []);
    else cb(null, [addr]);
  });
};

export const resolve6 = (hostname: string, cb: (err: Error | null, addrs: string[]) => void): void => {
  lookup(hostname, { family: 6 }, (err, addr) => {
    if (err) cb(err, []);
    else cb(null, [addr]);
  });
};

export const resolve = (hostname: string, ...rest: unknown[]): void => {
  const cb = (typeof rest[rest.length - 1] === 'function' ? rest[rest.length - 1] : undefined) as ((err: Error | null, val: unknown) => void) | undefined;
  if (!cb) throw new TypeError('callback required');
  resolve4(hostname, (err, addrs) => cb(err, addrs));
};

export const reverse = (ip: string, cb: (err: Error | null, hosts: string[]) => void): void => {
  Promise.resolve().then(() => cb(null, [ip]));
};

export const setServers = (_servers: string[]): void => undefined;
export const getServers = (): string[] => ['127.0.0.1'];

class Resolver {
  setServers = setServers;
  getServers = getServers;
  resolve = resolve;
  resolve4 = resolve4;
  resolve6 = resolve6;
  reverse = reverse;
}

const promises = {
  lookup: (hostname: string, opts?: { family?: number }): Promise<{ address: string; family: number }> => {
    return new Promise((resolve, reject) => {
      lookup(hostname, opts ?? {}, (err, address, family) => {
        if (err) reject(err);
        else resolve({ address, family });
      });
    });
  },
  resolve4: (hostname: string): Promise<string[]> => new Promise((resolve, reject) => {
    resolve4(hostname, (err, addrs) => err ? reject(err) : resolve(addrs));
  }),
  resolve6: (hostname: string): Promise<string[]> => new Promise((resolve, reject) => {
    resolve6(hostname, (err, addrs) => err ? reject(err) : resolve(addrs));
  }),
  Resolver,
};

export const nodeDns = {
  lookup,
  resolve,
  resolve4,
  resolve6,
  reverse,
  setServers,
  getServers,
  Resolver,
  promises,
  ADDRCONFIG: 32,
  V4MAPPED: 8,
};
