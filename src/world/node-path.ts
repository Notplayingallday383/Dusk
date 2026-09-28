const sep = '/';
const delimiter = ':';

const normalizePath = (path: string): string => {
  if (!path) return '.';
  const absolute = path.startsWith('/');
  const trailingSlash = path.endsWith('/');
  const parts = path.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') {
      if (stack.length > 0 && stack[stack.length - 1] !== '..') stack.pop();
      else if (!absolute) stack.push(part);
    }
    else stack.push(part);
  }
  let newPath = `${absolute ? '/' : ''}${stack.join('/')}`;
  if (!newPath) newPath = absolute ? '/' : '.';
  if (trailingSlash && newPath !== '/') newPath += '/';
  return newPath;
};

const removeTrailing = (path: string): string => {
  path = path.replace(/\/*$/, '');
  return path === '' ? '/' : path;
};

const normalize = (path: string): string => {
  const n = normalizePath(path);
  return n === '/' || n === '.' || path.endsWith('/') ? n : removeTrailing(n);
};

const basename = (path: string, ext?: string): string => {
  const base = path.split('/').pop() || '';
  if (ext && base.endsWith(ext)) return base.slice(0, -ext.length) || '/';
  return base === '' ? '/' : base;
};

const dirname = (path: string): string => {
  if (!path || path === '/') return '/';
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return '/' + parts.join('/');
};

const extname = (path: string): string => {
  const base = path.split('/').pop() || '';
  const idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx) : '';
};

type ParsedPath = {
  root: string;
  dir: string;
  base: string;
  ext: string;
  name: string;
};

type PathFormat = {
  root?: string;
  dir?: string;
  base?: string;
  name?: string;
  ext?: string;
};

const parse = (path: string): ParsedPath => {
  const root = path.startsWith('/') ? '/' : '';
  const trimmed = path.length > root.length ? path.replace(/\/+$/, '') : path;
  const slash = trimmed.lastIndexOf('/');
  const base = slash === -1 ? trimmed : trimmed.slice(slash + 1);
  const ext = extname(base);
  return {
    root,
    dir: slash === -1 ? '' : (slash === 0 ? '/' : trimmed.slice(0, slash)),
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
};

const format = (path: PathFormat): string => {
  const base = path.base || `${path.name || ''}${path.ext || ''}`;
  const dir = path.dir || path.root || '';
  return dir ? `${dir}${dir.endsWith('/') ? '' : '/'}${base}` : base;
};

const isAbsolute = (path: string): boolean => path.startsWith('/');

const join = (...paths: string[]): string =>
  paths
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/\/+$/, '') : p.replace(/^\/+|\/+$/g, '')))
    .join(sep);

const relative = (from: string, to: string): string => {
  const fromParts = normalizePath(from).split('/').filter(Boolean);
  const toParts = normalizePath(to).split('/').filter(Boolean);
  let i = 0;
  while (i < fromParts.length && i < toParts.length && fromParts[i] === toParts[i]) i++;
  const up = fromParts.slice(i).map(() => '..');
  const down = toParts.slice(i);
  return [...up, ...down].join('/') || '.';
};

const resolve = (...paths: string[]): string => {
  let resolved = '';
  for (const p of paths) {
    if (isAbsolute(p)) resolved = p;
    else resolved = join(resolved, p);
  }
  return normalize(resolved);
};

const parseWin32 = (path: string): ParsedPath => {
  const rootMatch = /^[A-Za-z]:[\\/]/.exec(path);
  const root = rootMatch?.[0] ?? ((path.startsWith('\\') || path.startsWith('/')) ? path[0] ?? '' : '');
  const trimmed = path.length > root.length ? path.replace(/[\\/]+$/, '') : path;
  const separator = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
  const base = separator === -1 ? trimmed : trimmed.slice(separator + 1);
  const ext = extname(base);
  return {
    root,
    dir: separator === -1 ? '' : (separator < root.length ? root : trimmed.slice(0, separator)),
    base,
    ext,
    name: ext ? base.slice(0, -ext.length) : base,
  };
};

const win32 = {
  sep: '\\',
  delimiter: ';',
  parse: parseWin32,
};

export const nodePath = {
  sep,
  delimiter,
  normalize,
  basename,
  dirname,
  extname,
  parse,
  format,
  isAbsolute,
  join,
  relative,
  resolve,
  posix: undefined as unknown,
  win32,
};

nodePath.posix = nodePath;
