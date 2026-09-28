import type { FuncTable, SendFn } from './runner';
import type { FSBackend } from './fs-backend';
import { transformStaticImports } from './esm-static-transform';
import { resolveModule } from './module-resolver';
import { createNativePackageRegistry, type NativePackageRegistry } from './native-package-registry';

export const createFuncs = (fs: FSBackend, out: (text: string) => void, nativePackageRegistry: NativePackageRegistry = createNativePackageRegistry()): FuncTable => {
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
    'module.resolve': (m, send) => { void (async () => { try { ok(send, await resolveModule(fs, m['request'] as string, m['fromDir'] as string, (m['mode'] as 'import' | 'require' | undefined) ?? 'import', new Set(), nativePackageRegistry)); } catch (e) { err(send, e); } })(); },
    'module.readSource': (m, send) => { void (async () => { try { const path = m['path'] as string; const source = nativePackageRegistry.readSource(path) ?? await fs.readFile(path); ok(send, m['mode'] === 'import' && !path.endsWith('.json') ? await transformStaticImports(source) : source); } catch (e) { err(send, e); } })(); },
  };
};
