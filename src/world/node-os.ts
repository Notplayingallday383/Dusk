import { osConstants, fsConstants, signalTable, errnoTable, priorityConstants } from './node-constants';

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

let _cachedHostname: string | undefined;

const readHostname = (): string => {
  if (_cachedHostname !== undefined) return _cachedHostname;
  try {
    const r = ipc.send({ f: 'fs.readFile', path: '/etc/hostname' });
    if (!r.error && typeof r.value === 'string') {
      _cachedHostname = r.value.trim();
      return _cachedHostname;
    }
  } catch { /* */ }
  _cachedHostname = 'duskjs';
  return _cachedHostname;
};

const procEnv = (): Record<string, string> => {
  const g = globalThis as Record<string, unknown>;
  const proc = g['process'] as { env?: Record<string, string> } | undefined;
  return proc?.env ?? {};
};

const detectEndianness = (): 'BE' | 'LE' => {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, 256, true);
  return new Int16Array(buf)[0] === 256 ? 'LE' : 'BE';
};

const EOL = '\n' as const;
const devNull = '/dev/null' as const;

export const nodeOs = {
  EOL,
  devNull,
  arch: () => 'wasm32' as const,
  platform: () => 'linux' as const,
  type: () => 'Linux',
  release: () => '0.0.0-dusk',
  version: () => '#1 DuskJS',
  endianness: detectEndianness,
  hostname: readHostname,
  tmpdir: () => '/tmp',
  homedir: () => procEnv()['HOME'] ?? '/home/user',
  machine: () => 'wasm32',
  availableParallelism: () => 1,

  userInfo: (_opts?: { encoding?: string }) => {
    const env = procEnv();
    const username = env['USER'] ?? env['LOGNAME'] ?? 'user';
    const home = env['HOME'] ?? `/home/${username}`;
    return {
      username,
      uid: 1000,
      gid: 1000,
      shell: env['SHELL'] ?? '/bin/sh',
      homedir: home,
    };
  },

  cpus: () => [{
    model: 'DuskJS Virtual CPU',
    speed: 0,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 },
  }],

  freemem: () => 0,
  totalmem: () => 0,
  loadavg: () => [0, 0, 0] as [number, number, number],
  networkInterfaces: () => ({}),

  uptime: () => {
    const g = globalThis as Record<string, unknown>;
    const proc = g['process'] as { uptime?: () => number } | undefined;
    return proc?.uptime ? proc.uptime() : 0;
  },

  getPriority: (_pid?: number) => 0,
  setPriority: (_arg1: number, _arg2?: number) => undefined,

  constants: {
    ...osConstants,
    signals: signalTable,
    errno: errnoTable,
    priority: priorityConstants,
    UV_UDP_REUSEADDR: 4,
    fs: fsConstants,
  },
};

export const default_ = nodeOs;
