import {
  ProcessManager,
  type DuskProcessHandle,
  type RelayListener,
} from './host/process-manager';
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
export type { RelayListener, RelaySocket } from './host/process-manager';
export { startRepl } from './repl/repl';
export { createMemoryBackend, createTfsBackend } from './host/fs-backend';
export { createLayoutBackend } from './host/fs-layout';
export { initEnginePool, isPoolWarm } from './host/engine-pool';
export { prewarmEngine } from './engine/spidermonkey';

export type BootReplNetOptions =
  | { loadLibcurl: () => Promise<LibCurl>; proxyUrl: string; relay?: RelayListener }
  | { relay: RelayListener; loadLibcurl?: never; proxyUrl?: never };

export interface BootReplOptions {
  net?: BootReplNetOptions;
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
  /**
   * Skip creating the pid-0 engine entirely. Saves ~100MB of RAM (a full
   * SpiderMonkey Worker) for callers that never use `feed()` and only spawn
   * child processes via `processManager.spawn(...)`. When set:
   *   - `.feed()` becomes a no-op that logs a warning
   *   - `.engine` is a lightweight stub that only implements `.terminate()`
   * Demo pages that spawn `/bin/dsh` interactively should set this.
   * Default: false (creates pid-0 for backwards compat).
   */
  skipPidZero?: boolean;
  /**
   * Path to a directory containing external binaries in the TFS filesystem.
   * Binaries in this directory will be automatically registered and made available
   * for execution. This allows storing custom executables in TFS and running them.
   * Example: '/usr/local/bin' or '/home/user/bin'
   */
  externalBinariesPath?: string;
  /**
   * Path to an environment variables file (e.g., '.env' file) in TFS.
   * The file should contain KEY=VALUE pairs, one per line.
   * These will be loaded and added to the process environment.
   * Example: '/home/user/.env' or '/.env'
   */
  envFilePath?: string;
  /**
   * Path to a bash history file in TFS (e.g., '.bash_history').
   * Command history will be loaded from and saved to this file.
   * Example: '/home/user/.bash_history'
   */
  historyFilePath?: string;
}

export interface BootReplResult extends DuskRepl {
  processManager: ProcessManager;
  /** pid-0 engine. Present unless `skipPidZero: true`, in which case it's a stub. */
  engine: EngineInstance;
  /** Present when `via: 'node'` — the spawned /bin/node child handle. */
  node?: DuskProcessHandle;
  /** History management utilities (if historyFilePath was provided) */
  history?: {
    /** Load command history from the history file */
    load(): Promise<string[]>;
    /** Append a command to the history file */
    append(command: string): Promise<void>;
    /** Save an array of commands to the history file (overwrites existing) */
    save(commands: string[]): Promise<void>;
  };
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
  if (options?.net?.loadLibcurl) {
    const net = createNet(
      options.net.loadLibcurl,
      (js) => { if (engineHolder.engine) engineHolder.engine.dispatch(js); },
      options.net.proxyUrl,
    );
    netFuncs = net.funcs;
  }

  let backend: FSBackend;
  let pm: ProcessManager;
  const processManagerOptions = options?.net?.relay ? { relay: options.net.relay } : {};
  // sqlite/python bridges get the same FSBackend the process manager sees.
  // We build them AFTER pm construction (see below) once `backend` is bound.
  let extraFuncs: FuncTable = {};
  if (useLayout) {
    const ephemeral = createMemoryBackend();
    // Build pm with persistent first (so binaries get registered), then swap to layout
    pm = new ProcessManager(persistent, netFuncs, {}, processManagerOptions);
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
    pm = new ProcessManager(backend, netFuncs, {}, processManagerOptions);
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

  // Load external binaries from the specified path
  if (options?.externalBinariesPath) {
    try {
      if (await backend.exists(options.externalBinariesPath)) {
        const files = await backend.readdir(options.externalBinariesPath);
        for (const file of files) {
          const fullPath = `${options.externalBinariesPath}/${file}`;
          const stat = await backend.stat(fullPath);
          if (stat.isFile) {
            try {
              const binarySource = await backend.readFile(fullPath);
              pm.registerBinary(`/bin/${file}`, binarySource);
            } catch (e) {
              console.warn(`Failed to load external binary ${file}:`, e);
            }
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load external binaries:', e);
    }
  }

  // Load environment variables from file
  let additionalEnv: Record<string, string> = {};
  if (options?.envFilePath) {
    try {
      if (await backend.exists(options.envFilePath)) {
        const envContent = await backend.readFile(options.envFilePath);
        const lines = envContent.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          // Skip comments and empty lines
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.slice(0, eqIndex).trim();
            let value = trimmed.slice(eqIndex + 1).trim();
            // Remove surrounding quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || 
                (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1);
            }
            additionalEnv[key] = value;
          }
        }
      }
    } catch (e) {
      console.warn('Failed to load environment file:', e);
    }
  }

  // Add history file path to environment if specified
  if (options?.historyFilePath) {
    additionalEnv['HISTFILE'] = options.historyFilePath;
    // Create history file if it doesn't exist
    try {
      if (!(await backend.exists(options.historyFilePath))) {
        const histDir = options.historyFilePath.split('/').slice(0, -1).join('/');
        if (histDir && !(await backend.exists(histDir))) {
          let cur = '';
          for (const seg of histDir.split('/').filter(Boolean)) {
            cur += '/' + seg;
            if (!(await backend.exists(cur))) await backend.mkdir(cur);
          }
        }
        await backend.writeFile(options.historyFilePath, '');
      }
    } catch (e) {
      console.warn('Failed to create history file:', e);
    }
  }

  // Optionally skip pid-0 — saves ~100MB of RAM by not spawning an entire
  // SpiderMonkey Worker for the `feed()` path. Only meaningful for callers
  // that will never call `.feed()` and only use `processManager.spawn(...)`.
  let engine: EngineInstance;
  if (options?.skipPidZero) {
    // Lightweight stub: satisfies .engine.terminate() from tests and demo,
    // ignores everything else. Any actual dispatch attempt will throw.
    let terminated = false;
    engine = {
      pid: 0,
      run: async (): Promise<void> => {
        throw new Error('bootRepl: pid-0 engine skipped (skipPidZero:true); use processManager.spawn instead');
      },
      dispatch: (): void => {
        throw new Error('bootRepl: pid-0 engine skipped (skipPidZero:true)');
      },
      terminate: async (): Promise<number> => { terminated = true; return 0; },
      get exited(): Promise<number> {
        return terminated ? Promise.resolve(0) : new Promise<number>(() => {});
      },
    };
  } else {
    engine = await pm.createPidZero(netFuncs, write, { user, hostname, additionalEnv });
    engineHolder.engine = engine;
  }

  if (options?.via === 'node') {
    // Spawn /bin/node with no args → enters REPL mode. No PTY: readline goes via
    // proc.readStdin polling in main.ts's startRepl (see binaries/node/main.ts).
    const home = `/home/${user}`;
    const nodeHandle = await pm.spawn('/bin/node', [], {
      env: { USER: user, HOME: home, PATH: '/bin', PWD: home, HOSTNAME: hostname, SHELL: '/bin/sh', TERM: 'dumb', ...additionalEnv },
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
    
    // Create history utilities if history file path was provided
    const history = options?.historyFilePath ? {
      load: async (): Promise<string[]> => {
        try {
          if (await backend.exists(options.historyFilePath!)) {
            const content = await backend.readFile(options.historyFilePath!);
            return content.split('\n').filter(line => line.trim().length > 0);
          }
        } catch (e) {
          console.warn('Failed to load history:', e);
        }
        return [];
      },
      append: async (command: string): Promise<void> => {
        try {
          const trimmed = command.trim();
          if (!trimmed) return;
          const existing = await backend.exists(options.historyFilePath!) 
            ? await backend.readFile(options.historyFilePath!) 
            : '';
          await backend.writeFile(options.historyFilePath!, existing + trimmed + '\n');
        } catch (e) {
          console.warn('Failed to append to history:', e);
        }
      },
      save: async (commands: string[]): Promise<void> => {
        try {
          const content = commands.filter(c => c.trim().length > 0).join('\n') + '\n';
          await backend.writeFile(options.historyFilePath!, content);
        } catch (e) {
          console.warn('Failed to save history:', e);
        }
      },
    } : undefined;
    
    return { feed, processManager: pm, engine, node: nodeHandle, history };
  }

  if (options?.skipPidZero) {
    // No pid-0 → no startRepl. Provide a feed() that clearly errors so
    // misuse surfaces immediately rather than silently no-oping.
    const feed = async (): Promise<void> => {
      throw new Error('bootRepl: feed() unavailable when skipPidZero:true. Spawn a shell via processManager.spawn(\'/bin/dsh\', ...) and write to its stdin.');
    };
    
    // Create history utilities if history file path was provided
    const history = options?.historyFilePath ? {
      load: async (): Promise<string[]> => {
        try {
          if (await backend.exists(options.historyFilePath!)) {
            const content = await backend.readFile(options.historyFilePath!);
            return content.split('\n').filter(line => line.trim().length > 0);
          }
        } catch (e) {
          console.warn('Failed to load history:', e);
        }
        return [];
      },
      append: async (command: string): Promise<void> => {
        try {
          const trimmed = command.trim();
          if (!trimmed) return;
          const existing = await backend.exists(options.historyFilePath!) 
            ? await backend.readFile(options.historyFilePath!) 
            : '';
          await backend.writeFile(options.historyFilePath!, existing + trimmed + '\n');
        } catch (e) {
          console.warn('Failed to append to history:', e);
        }
      },
      save: async (commands: string[]): Promise<void> => {
        try {
          const content = commands.filter(c => c.trim().length > 0).join('\n') + '\n';
          await backend.writeFile(options.historyFilePath!, content);
        } catch (e) {
          console.warn('Failed to save history:', e);
        }
      },
    } : undefined;
    
    return { feed, processManager: pm, engine, history };
  }

  const repl = startRepl(engine, write);
  
  // Create history utilities if history file path was provided
  const history = options?.historyFilePath ? {
    load: async (): Promise<string[]> => {
      try {
        if (await backend.exists(options.historyFilePath!)) {
          const content = await backend.readFile(options.historyFilePath!);
          return content.split('\n').filter(line => line.trim().length > 0);
        }
      } catch (e) {
        console.warn('Failed to load history:', e);
      }
      return [];
    },
    append: async (command: string): Promise<void> => {
      try {
        const trimmed = command.trim();
        if (!trimmed) return;
        const existing = await backend.exists(options.historyFilePath!) 
          ? await backend.readFile(options.historyFilePath!) 
          : '';
        await backend.writeFile(options.historyFilePath!, existing + trimmed + '\n');
      } catch (e) {
        console.warn('Failed to append to history:', e);
      }
    },
    save: async (commands: string[]): Promise<void> => {
      try {
        const content = commands.filter(c => c.trim().length > 0).join('\n') + '\n';
        await backend.writeFile(options.historyFilePath!, content);
      } catch (e) {
        console.warn('Failed to save history:', e);
      }
    },
  } : undefined;
  
  return { feed: repl.feed, processManager: pm, engine, history };
};
