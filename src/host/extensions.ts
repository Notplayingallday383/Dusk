import type { FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';

export type DuskExtensionManifest = {
  duskExtension: 1;
  host: {
    entry: string;
    binaries: string[];
    functions: string[];
  };
};

export type DuskExtensionHost = {
  packageName: string;
  entry: string;
  activate: (fs: FSBackend) => Promise<{ funcs: FuncTable; binaries: Record<string, string> }>;
};

export type LoadedDuskExtension = {
  funcs: FuncTable;
  binaries: Record<string, string>;
};

const trustedRegistry = 'https://registry.dusk.night-x.com/';

const isManifest = (value: unknown): value is DuskExtensionManifest => {
  if (!value || typeof value !== 'object') return false;
  const manifest = value as Partial<DuskExtensionManifest>;
  return manifest.duskExtension === 1
    && !!manifest.host
    && typeof manifest.host.entry === 'string'
    && Array.isArray(manifest.host.binaries)
    && manifest.host.binaries.every((name) => typeof name === 'string' && name.startsWith('/bin/'))
    && Array.isArray(manifest.host.functions)
    && manifest.host.functions.every((name) => typeof name === 'string' && name.includes('.'));
};

const packagePath = (cwd: string, name: string): string => `${cwd.replace(/\/$/, '')}/node_modules/${name}`;

export const loadDuskExtensions = async (
  fs: FSBackend,
  cwd: string,
  hosts: readonly DuskExtensionHost[],
): Promise<LoadedDuskExtension[]> => {
  if (hosts.length === 0) return [];
  const lock = JSON.parse(await fs.readFile(`${cwd}/package-lock.json`)) as {
    packages?: Record<string, { resolved?: string; integrity?: string }>;
  };
  const loaded: LoadedDuskExtension[] = [];
  for (const host of hosts) {
    const path = packagePath(cwd, host.packageName);
    const locked = lock.packages?.[`node_modules/${host.packageName}`];
    if (!locked?.integrity || !locked.resolved?.startsWith(trustedRegistry)) {
      throw new Error(`dusk extension ${host.packageName} lacks trusted lockfile integrity`);
    }
    const pkg = JSON.parse(await fs.readFile(`${path}/package.json`)) as { name?: string };
    let manifestValue: unknown;
    try { manifestValue = JSON.parse(await fs.readFile(`${path}/dusk.extension`)); }
    catch { throw new Error(`unsupported dusk extension manifest for ${host.packageName}`); }
    if (pkg.name !== host.packageName || !isManifest(manifestValue)) {
      throw new Error(`unsupported dusk extension manifest for ${host.packageName}`);
    }
    const manifest = manifestValue;
    if (manifest.host.entry !== host.entry) {
      throw new Error(`dusk extension host entry mismatch for ${host.packageName}`);
    }
    const activated = await host.activate(fs);
    const binaries = Object.keys(activated.binaries);
    const funcs = Object.keys(activated.funcs);
    if (binaries.some((name) => !manifest.host.binaries.includes(name))
      || funcs.some((name) => !manifest.host.functions.includes(name))) {
      throw new Error(`dusk extension ${host.packageName} attempted undeclared capabilities`);
    }
    loaded.push(activated);
  }
  return loaded;
};
