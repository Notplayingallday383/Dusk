const sep = '/';
const delimiter = ':';

const normalizePath = (path: string): string => {
  if (!path) return '/';
  if (!path.startsWith('/')) path = '//' + path;
  const parts = path.split('/').filter(Boolean);
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '.' || part === '') continue;
    if (part === '..') { if (stack.length > 0) stack.pop(); }
    else stack.push(part);
  }
  let newPath = '/' + stack.join('/');
  if (newPath === '//') newPath = '/';
  return newPath;
};

const removeTrailing = (path: string): string => {
  path = path.replace(/\/*$/, '');
  return path === '' ? '/' : path;
};

const normalize = (path: string): string => {
  const n = normalizePath(path);
  return n === '/' ? '/' : removeTrailing(n);
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

export const nodePath = {
  sep,
  delimiter,
  normalize,
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
};
