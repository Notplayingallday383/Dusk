// Shell scope + function table.

export interface ShellVar {
  value: string | string[];
  readonly: boolean;
  exported: boolean;
  isInteger: boolean;
  isArray: boolean;
}

export interface FunctionDef {
  name: string;
  body: unknown;  // AnyCmd; typed as unknown here to avoid AST import cycles
}

export interface ScopeFrame {
  parent: ScopeFrame | null;
  vars: Map<string, ShellVar>;
  // Only the root frame stores functions, aliases, options
}

export interface SetOptions {
  errexit: boolean;    // -e
  nounset: boolean;    // -u
  xtrace: boolean;     // -x
  pipefail: boolean;
  noglob: boolean;     // -f
  noexec: boolean;     // -n (parse only)
  monitor: boolean;    // -m (job control; we stub)
  noclobber: boolean;  // -C
  allexport: boolean;  // -a
}

export interface ShoptOptions {
  extglob: boolean;
  globstar: boolean;
  nullglob: boolean;
  failglob: boolean;
  dotglob: boolean;
  nocaseglob: boolean;
  nocasematch: boolean;
}

export interface ShellState {
  // The deepest active frame; function calls push, returns pop.
  topFrame: ScopeFrame;
  // Root frame stores functions, aliases, traps, etc.
  rootFrame: ScopeFrame;

  functions: Map<string, FunctionDef>;
  aliases: Map<string, string>;
  traps: Map<string, string | null>;  // sig name -> command body; null = ignore

  setOptions: SetOptions;
  shopt: ShoptOptions;

  positional: string[];   // $1, $2, ... ($0 is positional[0])
  scriptName: string;     // $0

  exitCode: number;
  exitRequested: boolean;
  exitRequestedCode: number;
  pipeStatus: number[];   // PIPESTATUS

  cwd: string;
  oldPwd: string;

  // Execution accounting (for limits + observability)
  loopBreakDepth: number;
  loopContinueDepth: number;
  returnRequested: boolean;
  returnRequestedCode: number;

  // Backreferences
  history: string[];
  randomSeed: number;
  startTimeMs: number;

  // Pipeline group id + killed flag, populated by the pipeline runner while a
  // pipeline is executing. `null` when no pipeline is active.
  pipelineGroup: { pgid: number; killed: boolean } | null;
}

export const newScopeFrame = (parent: ScopeFrame | null = null): ScopeFrame => ({
  parent,
  vars: new Map(),
});

export const lookupVar = (state: ShellState, name: string): ShellVar | undefined => {
  let frame: ScopeFrame | null = state.topFrame;
  while (frame) {
    const v = frame.vars.get(name);
    if (v) return v;
    frame = frame.parent;
  }
  return undefined;
};

export const getVarValue = (state: ShellState, name: string): string | undefined => {
  const v = lookupVar(state, name);
  if (!v) return undefined;
  if (Array.isArray(v.value)) return v.value.join(' ');
  return v.value;
};

export const setVar = (
  state: ShellState,
  name: string,
  value: string | string[],
  opts: { local?: boolean; exported?: boolean; readonly?: boolean; append?: boolean; integer?: boolean } = {},
): void => {
  let target: ScopeFrame;
  if (opts.local) {
    target = state.topFrame;
  } else {
    // Find existing binding in any frame; if none, write to root.
    let frame: ScopeFrame | null = state.topFrame;
    target = state.rootFrame;
    while (frame) {
      if (frame.vars.has(name)) { target = frame; break; }
      frame = frame.parent;
    }
  }
  const existing = target.vars.get(name);
  if (existing?.readonly && !opts.readonly) {
    const err = new Error(`${name}: readonly variable`);
    (err as Error & { code?: string }).code = 'EROFS';
    throw err;
  }
  let nextValue: string | string[] = value;
  if (opts.append && existing) {
    if (Array.isArray(existing.value) && Array.isArray(value)) {
      nextValue = [...existing.value, ...value];
    } else {
      const left = Array.isArray(existing.value) ? existing.value.join(' ') : existing.value;
      const right = Array.isArray(value) ? value.join(' ') : value;
      nextValue = left + right;
    }
  }
  target.vars.set(name, {
    value: nextValue,
    readonly: existing?.readonly ?? opts.readonly ?? false,
    exported: opts.exported ?? existing?.exported ?? false,
    isInteger: opts.integer ?? existing?.isInteger ?? false,
    isArray: Array.isArray(nextValue),
  });
};

export const unsetVar = (state: ShellState, name: string): void => {
  let frame: ScopeFrame | null = state.topFrame;
  while (frame) {
    if (frame.vars.has(name)) { frame.vars.delete(name); return; }
    frame = frame.parent;
  }
};

export const exportVar = (state: ShellState, name: string, valueOrUndef?: string): void => {
  if (valueOrUndef !== undefined) setVar(state, name, valueOrUndef, { exported: true });
  else {
    const v = lookupVar(state, name);
    if (v) v.exported = true;
  }
};

export const pushFrame = (state: ShellState): ScopeFrame => {
  const frame = newScopeFrame(state.topFrame);
  state.topFrame = frame;
  return frame;
};

export const popFrame = (state: ShellState): void => {
  if (state.topFrame.parent) {
    state.topFrame = state.topFrame.parent;
  }
};

export const buildEnvSnapshot = (state: ShellState): Record<string, string> => {
  const out: Record<string, string> = {};
  // Collect all exported vars walking from root upward, with deepest scope winning.
  const collect = (frame: ScopeFrame | null): void => {
    if (!frame) return;
    collect(frame.parent);
    for (const [name, v] of frame.vars) {
      if (v.exported) {
        out[name] = Array.isArray(v.value) ? v.value.join(' ') : v.value;
      }
    }
  };
  collect(state.topFrame);
  return out;
};

export const createInitialState = (initial?: Partial<ShellState>): ShellState => {
  const rootFrame = newScopeFrame(null);
  const state: ShellState = {
    topFrame: rootFrame,
    rootFrame,
    functions: new Map(),
    aliases: new Map(),
    traps: new Map(),
    setOptions: {
      errexit: false, nounset: false, xtrace: false, pipefail: false,
      noglob: false, noexec: false, monitor: false, noclobber: false, allexport: false,
    },
    shopt: {
      extglob: false, globstar: false, nullglob: false, failglob: false,
      dotglob: false, nocaseglob: false, nocasematch: false,
    },
    positional: initial?.positional ?? ['sh'],
    scriptName: initial?.scriptName ?? 'sh',
    exitCode: 0,
    exitRequested: false,
    exitRequestedCode: 0,
    pipeStatus: [],
    cwd: initial?.cwd ?? '/',
    oldPwd: initial?.oldPwd ?? '/',
    loopBreakDepth: 0,
    loopContinueDepth: 0,
    returnRequested: false,
    returnRequestedCode: 0,
    history: [],
    randomSeed: Math.floor(Math.random() * 0xffffffff),
    startTimeMs: Date.now(),
    pipelineGroup: null,
  };
  // Seed initial env vars as exported vars
  if (initial?.rootFrame) {
    // Caller provided a custom root — use as-is
  } else {
    const initEnv = (initial as { env?: Record<string, string> } | undefined)?.env ?? {};
    for (const [k, v] of Object.entries(initEnv)) {
      setVar(state, k, v, { exported: true });
    }
  }
  return state;
};
