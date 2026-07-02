import type { FuncTable, SendFn } from './runner';
import type { FSBackend } from './fs-backend';
import { norm, dirname } from './vfs';

const resolveModule = async (fs: FSBackend, request: string, fromDir: string): Promise<string> => {
  const tryFile = async (p: string): Promise<string | null> => {
    const n = norm(p);
    if ((await fs.exists(n)) && (await fs.stat(n)).isFile) return n;
    for (const ext of ['.js', '.json', '.cjs', '.mjs']) if (await fs.exists(n + ext)) return n + ext;
    if ((await fs.exists(n)) && (await fs.stat(n)).isDirectory) {
      if (await fs.exists(n + '/package.json')) {
        const main = (JSON.parse(await fs.readFile(n + '/package.json')) as { main?: string }).main;
        if (main) { const m = await tryFile(n + '/' + main); if (m) return m; }
      }
      const idx = await tryFile(n + '/index');
      if (idx) return idx;
    }
    return null;
  };

  if (request.startsWith('./') || request.startsWith('../') || request.startsWith('/')) {
    const m = await tryFile(request.startsWith('/') ? request : fromDir + '/' + request);
    if (m) return m;
    throw new Error('Cannot find module ' + request);
  }

  let dir = fromDir;
  while (true) {
    const m = await tryFile(dir + '/node_modules/' + request);
    if (m) return m;
    if (dir === '/' || dir === '') break;
    dir = dirname(dir);
  }
  throw new Error('Cannot find module ' + request);
};

export const createFuncs = (fs: FSBackend, out: (text: string) => void): FuncTable => {
  const ok = (send: SendFn, value: unknown): void => send({ value });
  const err = (send: SendFn, e: unknown): void => send({ error: e instanceof Error ? (e.stack ?? e.message) : String(e) });

  return {
    'console.log': (msg, send) => { out(((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n'); send({}); },
    'console.error': (msg, send) => { out(((msg['args'] as unknown[]) ?? []).map(String).join(' ') + '\n'); send({}); },
    'process.cwd': (_m, send) => ok(send, '/'),
    'process.exit': (_m, send) => { send({}); },
    'proc.write': (m, send) => {
      const data = m['data'] as number[] | undefined;
      if (data) out(new TextDecoder().decode(new Uint8Array(data)));
      send({});
    },
    'fs.readFile': (m, send) => { void (async () => { try { ok(send, await fs.readFile(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.writeFile': (m, send) => { void (async () => { try { await fs.writeFile(m['path'] as string, m['data'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.readdir': (m, send) => { void (async () => { try { ok(send, await fs.readdir(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.mkdir': (m, send) => { void (async () => { try { await fs.mkdir(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.rm': (m, send) => { void (async () => { try { await fs.rm(m['path'] as string, { recursive: Boolean(m['recursive']) }); ok(send, true); } catch (e) { err(send, e); } })(); },
    'fs.exists': (m, send) => { void (async () => { try { ok(send, await fs.exists(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.stat': (m, send) => { void (async () => { try { ok(send, await fs.stat(m['path'] as string)); } catch (e) { err(send, e); } })(); },
    'fs.rename': (m, send) => { void (async () => { try { await fs.rename(m['from'] as string, m['to'] as string); ok(send, true); } catch (e) { err(send, e); } })(); },
    'module.resolve': (m, send) => { void (async () => { try { ok(send, await resolveModule(fs, m['request'] as string, m['fromDir'] as string)); } catch (e) { err(send, e); } })(); },
    'module.readSource': (m, send) => { void (async () => { try { ok(send, await fs.readFile(m['path'] as string)); } catch (e) { err(send, e); } })(); },
  };
};

export { resolveModule };
