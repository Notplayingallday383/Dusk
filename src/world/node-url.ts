// Wrapper around the global WHATWG URL + legacy `url` module helpers.

type URLCtor = new (input: string, base?: string | URL) => URL;
type USPCtor = new (init?: string | string[][] | Record<string, string> | URLSearchParams) => URLSearchParams;

const _URL: URLCtor = (globalThis as { URL?: URLCtor }).URL ?? (class { constructor() { throw new Error('URL not available'); } } as unknown as URLCtor);
const _URLSearchParams: USPCtor = (globalThis as { URLSearchParams?: USPCtor }).URLSearchParams ?? (class { constructor() { throw new Error('URLSearchParams not available'); } } as unknown as USPCtor);

export { _URL as URL, _URLSearchParams as URLSearchParams };

export const fileURLToPath = (url: string | URL): string => {
  const u = typeof url === 'string' ? new _URL(url) : url;
  if (u.protocol !== 'file:') {
    const e = new TypeError(`The URL must be of scheme file: got '${u.protocol}'`);
    (e as Error & { code?: string }).code = 'ERR_INVALID_URL_SCHEME';
    throw e;
  }
  return decodeURIComponent(u.pathname);
};

export const pathToFileURL = (p: string): URL => {
  const abs = p.startsWith('/') ? p : '/' + p;
  return new _URL('file://' + encodeURI(abs).replace(/#/g, '%23').replace(/\?/g, '%3F'));
};

export const urlToHttpOptions = (url: URL): Record<string, unknown> => {
  return {
    protocol: url.protocol,
    hostname: url.hostname,
    hash: url.hash,
    search: url.search,
    pathname: url.pathname,
    path: `${url.pathname || ''}${url.search || ''}`,
    href: url.href,
    port: url.port,
    auth: url.username || url.password ? `${url.username}${url.password ? ':' + url.password : ''}` : undefined,
  };
};

// ---- Legacy parse/format/resolve ----

interface LegacyUrl {
  protocol: string | null;
  slashes: boolean | null;
  auth: string | null;
  host: string | null;
  port: string | null;
  hostname: string | null;
  hash: string | null;
  search: string | null;
  query: string | Record<string, string | string[]> | null;
  pathname: string | null;
  path: string | null;
  href: string;
}

export const parse = (urlStr: string, parseQueryString = false, _slashesDenoteHost = false): LegacyUrl => {
  try {
    const u = new _URL(urlStr, 'http://__base__/');
    const isAbs = !urlStr.startsWith('/') && /^[a-z][a-z0-9+\-.]*:/i.test(urlStr);
    const auth = u.username || u.password ? `${u.username}${u.password ? ':' + u.password : ''}` : null;
    const hash = u.hash || null;
    const search = u.search || null;
    const query = parseQueryString
      ? Object.fromEntries(u.searchParams)
      : (u.search ? u.search.slice(1) : null);
    return {
      protocol: isAbs ? u.protocol : null,
      slashes: isAbs ? true : null,
      auth,
      host: isAbs ? u.host : null,
      port: isAbs && u.port ? u.port : null,
      hostname: isAbs ? u.hostname : null,
      hash,
      search,
      query,
      pathname: u.pathname || null,
      path: `${u.pathname || ''}${u.search || ''}` || null,
      href: isAbs ? u.href : urlStr,
    };
  } catch {
    return {
      protocol: null, slashes: null, auth: null, host: null, port: null,
      hostname: null, hash: null, search: null, query: null,
      pathname: urlStr, path: urlStr, href: urlStr,
    };
  }
};

export const format = (urlObj: LegacyUrl | URL | Record<string, unknown>): string => {
  if (urlObj instanceof _URL) return urlObj.href;
  const o = urlObj as LegacyUrl;
  let out = '';
  if (o.protocol) out += o.protocol + (o.slashes === false ? '' : '//');
  if (o.auth) out += o.auth + '@';
  if (o.hostname) out += o.hostname;
  if (o.port) out += ':' + o.port;
  if (o.pathname) out += o.pathname;
  if (o.search) out += o.search;
  if (o.hash) out += o.hash;
  return out;
};

export const resolve = (from: string, to: string): string => {
  try { return new _URL(to, from).href; } catch { return to; }
};

export const domainToASCII = (d: string): string => {
  try { return new _URL(`http://${d}`).hostname; } catch { return ''; }
};
export const domainToUnicode = (d: string): string => d;

export const nodeUrl = {
  URL: _URL,
  URLSearchParams: _URLSearchParams,
  fileURLToPath,
  pathToFileURL,
  urlToHttpOptions,
  parse,
  format,
  resolve,
  domainToASCII,
  domainToUnicode,
};
