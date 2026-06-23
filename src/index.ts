import { createRunner, type DuskRunner } from './host/runner';
import { createFuncs } from './host/funcs';
import { createNet, type LibCurl } from './host/net';
import { createMemoryBackend, createTfsBackend, type FSBackend } from './host/fs-backend';
import { startRepl, type DuskRepl } from './repl/repl';

export { createRunner } from './host/runner';
export { startRepl } from './repl/repl';
export { createMemoryBackend, createTfsBackend } from './host/fs-backend';

export interface BootReplOptions {
  net?: { loadLibcurl: () => Promise<LibCurl>; proxyUrl: string };
  seed?: Record<string, string>;
  fs?: 'tfs' | 'memory';
}

export const bootRepl = async (
  write: (text: string) => void,
  options?: BootReplOptions,
): Promise<DuskRepl> => {
  const backend: FSBackend = (options?.fs ?? 'tfs') === 'memory'
    ? createMemoryBackend()
    : await createTfsBackend();
  for (const [path, contents] of Object.entries(options?.seed ?? {})) {
    const segs = path.split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) { cur += '/' + s; if (!(await backend.exists(cur))) await backend.mkdir(cur); }
    await backend.writeFile(path, contents);
  }
  let runner: DuskRunner;
  let funcs = createFuncs(backend, write);
  if (options?.net) {
    const net = createNet(options.net.loadLibcurl, (js) => runner.dispatch(js), options.net.proxyUrl);
    funcs = { ...funcs, ...net.funcs };
  }
  runner = await createRunner(funcs);
  return startRepl(runner, write);
};

if (typeof document !== 'undefined' && import.meta.env?.MODE !== 'test') {
  void (async () => {
    const params = new URLSearchParams(location.search);
    if (params.get('demo') === 'scripted') {
      const { startScripted } = await import('./demo/scripted');
      await startScripted();
    } else {
      const { startPage } = await import('./demo/page');
      await startPage();
    }
  })();
}
