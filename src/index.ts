import { ProcessManager, type DuskProcessHandle } from './host/process-manager';
import { createNet, type LibCurl } from './host/net';
import { createMemoryBackend, createTfsBackend, type FSBackend } from './host/fs-backend';
import { createLayoutBackend } from './host/fs-layout';
import { createSqliteFuncs } from './host/sqlite';
import { createPythonFuncs } from './host/python';
import { startRepl, type DuskRepl } from './repl/repl';
import type { EngineInstance, FuncTable } from './host/engine-instance';

export { createRunner } from './host/runner';
export { createEngine } from './host/engine-instance';
export { ProcessManager } from './host/process-manager';
export { startRepl } from './repl/repl';
export { createMemoryBackend, createTfsBackend } from './host/fs-backend';
export { createLayoutBackend } from './host/fs-layout';
export { initEnginePool, isPoolWarm } from './host/engine-pool';
export { prewarmEngine } from './engine/spidermonkey';

export interface BootReplOptions {
  net?: { loadLibcurl: () => Promise<LibCurl>; proxyUrl: string };
  seed?: Record<string, string>;
  fs?: 'tfs' | 'memory';
  user?: string;
  hostname?: string;
  layout?: boolean;
  /**
   * Routing for `feed(line)`:
   * - 'startRepl' (default): dispatch wrapped JS through the pid-0 engine via startRepl().
   * - 'node': spawn `/bin/node` (no args, no PTY) as a child; feed writes to its stdin
   *   and the child's stdout/stderr are decoded and forwarded to `write`.
   */
  via?: 'startRepl' | 'node';
}

export interface BootReplResult extends DuskRepl {
  processManager: ProcessManager;
  /** pid-0 engine. Kept for backwards compat (tests call `repl.engine.terminate()`). */
  engine: EngineInstance;
  /** Present when `via: 'node'` — the spawned /bin/node child handle. */
  node?: DuskProcessHandle;
}

export const bootRepl = async (
  write: (text: string) => void,
  options?: BootReplOptions,
): Promise<BootReplResult> => {
  const user = options?.user ?? 'user';
  const hostname = options?.hostname ?? 'duskjs';
  const useLayout = options?.layout !== false;

  // Pre-warm the engine pool so additional spawns are faster.
  // Idempotent across calls.
  const { initEnginePool } = await import('./host/engine-pool');
  initEnginePool();

  const persistent: FSBackend = (options?.fs ?? 'tfs') === 'memory'
    ? createMemoryBackend()
    : await createTfsBackend();

  const engineHolder: { engine: EngineInstance | null } = { engine: null };
  let netFuncs: FuncTable = {};
  if (options?.net) {
    const net = createNet(
      options.net.loadLibcurl,
      (js) => { if (engineHolder.engine) engineHolder.engine.dispatch(js); },
      options.net.proxyUrl,
    );
    netFuncs = net.funcs;
  }

  let backend: FSBackend;
  let pm: ProcessManager;
  // sqlite/python bridges get the same FSBackend the process manager sees.
  // We build them AFTER pm construction (see below) once `backend` is bound.
  let extraFuncs: FuncTable = {};
  if (useLayout) {
    const ephemeral = createMemoryBackend();
    // Build pm with persistent first (so binaries get registered), then swap to layout
    pm = new ProcessManager(persistent, netFuncs);
    backend = await createLayoutBackend({
      ephemeral,
      persistent,
      processManager: pm,
      user,
      hostname,
    });
    (pm as unknown as { fs: FSBackend }).fs = backend;
  } else {
    backend = persistent;
    pm = new ProcessManager(backend, netFuncs);
  }
  // Register sqlite and python IPC bridges against the effective backend.
  // Merge into the pm's netFuncs bag so all subsequent spawns see them.
  extraFuncs = { ...createSqliteFuncs(backend), ...createPythonFuncs(backend) };
  (pm as unknown as { netFuncs: FuncTable }).netFuncs = {
    ...(pm as unknown as { netFuncs: FuncTable }).netFuncs,
    ...extraFuncs,
  };

  for (const [path, contents] of Object.entries(options?.seed ?? {})) {
    const segs = path.split('/').filter(Boolean);
    segs.pop();
    let cur = '';
    for (const s of segs) { cur += '/' + s; if (!(await backend.exists(cur))) await backend.mkdir(cur); }
    await backend.writeFile(path, contents);
  }

  const engine = await pm.createPidZero(netFuncs, write, { user, hostname });
  engineHolder.engine = engine;

  if (options?.via === 'node') {
    // Spawn /bin/node with no args → enters REPL mode. No PTY: readline goes via
    // proc.readStdin polling in main.ts's startRepl (see binaries/node/main.ts).
    const home = `/home/${user}`;
    const nodeHandle = await pm.spawn('/bin/node', [], {
      env: { USER: user, HOME: home, PATH: '/bin', PWD: home, HOSTNAME: hostname, SHELL: '/bin/sh', TERM: 'dumb' },
      cwd: home,
    });
    // Reader loop: decode child stdout/stderr → write().
    const decoder = new TextDecoder();
    const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value && value.length) write(decoder.decode(value, { stream: true }));
        }
        const tail = decoder.decode();
        if (tail) write(tail);
      } catch { /* stream closed */ }
    };
    void pump(nodeHandle.stdout);
    void pump(nodeHandle.stderr);

    const encoder = new TextEncoder();
    const feed = async (line: string): Promise<void> => {
      await nodeHandle.stdin.write(encoder.encode(line + '\n'));
    };
    return { feed, processManager: pm, engine, node: nodeHandle };
  }

  const repl = startRepl(engine, write);
  return { feed: repl.feed, processManager: pm, engine };
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
