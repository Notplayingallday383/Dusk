// Shell v2 executor — async AST walker with concurrent pipelines.

import type {
  AnyCmd, AndOrList, CaseStatement, CForLoop, CompoundList, FunctionDecl,
  ForLoop, IfStatement, ListSequence, Pipeline, Redirect, SimpleCommand,
  Subshell, BraceGroup, WhileLoop, Word, WordPart, DoubleBracket,
} from './ast';
import { evalBoolExpr } from './dbracket';
import { expandWord, expandWordToString } from './expander';
import { tokenize } from './tokenizer-v2';
import { parse } from './parser-v2';
import {
  buildEnvSnapshot, getVarValue, popFrame, pushFrame, setVar, unsetVar,
  type ShellState,
} from './scope';
import { builtins, isBuiltin, type BuiltinIo } from './builtins-v2';

export interface ExecResult {
  status: number;
}

interface CaptureBuffer {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
}

interface IoContext {
  // If set, stdout writes are captured here instead of going to process.stdout
  captureStdout?: CaptureBuffer;
  // If set, stderr writes are captured similarly
  captureStderr?: CaptureBuffer;
  // The stdin bytes available for the command (e.g. from a pipe)
  stdin: Uint8Array;
}

const encodeUtf8 = (s: string): Uint8Array => {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    let c = s.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
  }
  return Uint8Array.from(out);
};

const decodeUtf8 = (b: Uint8Array): string => {
  let s = '';
  let i = 0;
  while (i < b.length) {
    const b1 = b[i++]!;
    if (b1 < 0x80) { s += String.fromCharCode(b1); continue; }
    if (b1 < 0xc0) continue;
    if (b1 < 0xe0) {
      const b2 = b[i++];
      if (b2 === undefined) break;
      s += String.fromCharCode(((b1 & 0x1f) << 6) | (b2 & 0x3f));
      continue;
    }
    if (b1 < 0xf0) {
      const b2 = b[i++]; const b3 = b[i++];
      if (b2 === undefined || b3 === undefined) break;
      s += String.fromCharCode(((b1 & 0x0f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f));
      continue;
    }
    const b2 = b[i++]; const b3 = b[i++]; const b4 = b[i++];
    if (b2 === undefined || b3 === undefined || b4 === undefined) break;
    const cp = ((b1 & 0x07) << 18) | ((b2 & 0x3f) << 12) | ((b3 & 0x3f) << 6) | (b4 & 0x3f);
    const off = cp - 0x10000;
    s += String.fromCharCode(0xd800 | (off >> 10), 0xdc00 | (off & 0x3ff));
  }
  return s;
};

const concat = (parts: Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

const emitStdout = (data: Uint8Array, io: IoContext): void => {
  if (io.captureStdout) {
    io.captureStdout.stdout.push(data);
    return;
  }
  const proc = (globalThis as Record<string, unknown>)['process'] as { stdout?: { write: (d: Uint8Array) => void } } | undefined;
  if (proc?.stdout) proc.stdout.write(data);
};

const emitStderr = (data: Uint8Array, io: IoContext): void => {
  if (io.captureStderr) {
    io.captureStderr.stderr.push(data);
    return;
  }
  const proc = (globalThis as Record<string, unknown>)['process'] as { stderr?: { write: (d: Uint8Array) => void } } | undefined;
  if (proc?.stderr) proc.stderr.write(data);
};

// File system helpers via __fs global
const readFileText = (path: string): string => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { readFile?: (p: string) => string } | undefined;
  if (!fs?.readFile) throw new Error('__fs not available');
  return fs.readFile(path);
};
const writeFileText = (path: string, data: string): void => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { writeFile?: (p: string, d: string) => void } | undefined;
  if (!fs?.writeFile) throw new Error('__fs not available');
  fs.writeFile(path, data);
};

// Resolve external command via PATH
const resolveExternal = (cmd: string, state: ShellState): string | null => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { exists?: (p: string) => boolean } | undefined;
  if (cmd.startsWith('/') || cmd.startsWith('./') || cmd.startsWith('../')) return cmd;
  if (!fs?.exists) return null;
  const pathEnv = getVarValue(state, 'PATH') ?? '/bin';
  for (const dir of pathEnv.split(':')) {
    if (!dir) continue;
    const candidate = (dir.endsWith('/') ? dir : dir + '/') + cmd;
    try { if (fs.exists(candidate)) return candidate; } catch { /* */ }
  }
  return null;
};

// Run a command substitution by tokenizing/parsing/executing in a sub-context
// that captures stdout and returns the result as a string.
const runCmdsub = (state: ShellState) => async (script: string): Promise<string> => {
  const buf: CaptureBuffer = { stdout: [], stderr: [] };
  const subState: ShellState = { ...state, exitCode: state.exitCode };
  try {
    const { tokens, heredocs } = tokenize(script);
    const ast = parse(tokens, heredocs);
    await executeCompoundList(ast, subState, { stdin: new Uint8Array(0), captureStdout: buf });
  } catch (e) {
    // Errors in command substitution write to stderr of the OUTER context (not captured here)
    const proc = (globalThis as Record<string, unknown>)['process'] as { stderr?: { write: (d: Uint8Array) => void } } | undefined;
    if (proc?.stderr) proc.stderr.write(encodeUtf8(String(e) + '\n'));
  }
  return decodeUtf8(concat(buf.stdout));
};

// Apply input redirects to determine the effective stdin bytes.
const applyInputRedirects = async (
  redirects: Redirect[], fallback: Uint8Array, state: ShellState, ctx: { runCmdsub: (s: string) => Promise<string> },
): Promise<Uint8Array> => {
  let stdin = fallback;
  for (const r of redirects) {
    if (r.kind === 'in' && r.fd === 0 && r.target) {
      const path = await expandWordToString(r.target, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
      try { stdin = encodeUtf8(readFileText(path)); } catch { stdin = new Uint8Array(0); }
    } else if (r.kind === 'heredoc' && r.fd === 0) {
      let body = r.body ?? '';
      if (r.expandHeredoc) {
        // Apply parameter/cmd/arith expansion in the body
        const { tokens, heredocs } = tokenize('cat <<__DUMMY__\n' + body + '__DUMMY__\n');
        // Simpler approach: tokenize the body as a double-quoted word's contents
        body = await expandHeredocBody(body, state, ctx.runCmdsub);
      }
      stdin = encodeUtf8(body);
    } else if (r.kind === 'herestring' && r.fd === 0 && r.herestring) {
      const text = await expandWordToString(r.herestring, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
      stdin = encodeUtf8(text + '\n');
    }
  }
  return stdin;
};

const expandHeredocBody = async (body: string, state: ShellState, run: (s: string) => Promise<string>): Promise<string> => {
  // Wrap the body in double quotes effectively — variables expand, command sub expands.
  const fakeScript = ':<< __DUSK_HEREDOC_PROBE__\n__DUSK_HEREDOC_PROBE__\n';
  void fakeScript;
  // Simpler: walk the body and expand $VAR, ${...}, $(...), $((...)) inline.
  let out = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i]!;
    if (c === '\\') {
      const n = body[i + 1];
      if (n === '$' || n === '`' || n === '\\' || n === '\n') {
        if (n !== '\n') out += n;
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === '$') {
      const peek = body[i + 1];
      if (peek === '(') {
        if (body[i + 2] === '(') {
          // Arith
          let depth = 1;
          let expr = '';
          let j = i + 3;
          while (j < body.length && depth > 0) {
            const cc = body[j]!;
            if (cc === '(') { depth++; expr += cc; j++; continue; }
            if (cc === ')') {
              if (body[j + 1] === ')' && depth === 1) { j += 2; break; }
              depth--; expr += cc; j++; continue;
            }
            expr += cc; j++;
          }
          try {
            const { evalArithString } = await import('./arith');
            out += String(evalArithString(expr, state));
          } catch { out += '0'; }
          i = j;
          continue;
        }
        // $(cmd)
        let depth = 1;
        let script = '';
        let j = i + 2;
        while (j < body.length && depth > 0) {
          const cc = body[j]!;
          if (cc === '(') { depth++; script += cc; j++; continue; }
          if (cc === ')') { depth--; if (depth === 0) { j++; break; } script += cc; j++; continue; }
          script += cc; j++;
        }
        try { out += (await run(script)).replace(/\n+$/, ''); } catch { /* */ }
        i = j;
        continue;
      }
      if (peek === '{') {
        const close = findMatchingBrace(body, i + 1);
        if (close === -1) { out += c; i++; continue; }
        const name = body.slice(i + 2, close);
        out += getVarValue(state, name) ?? '';
        i = close + 1;
        continue;
      }
      if (peek !== undefined && /[A-Za-z_0-9?#@*!$-_]/.test(peek)) {
        let j = i + 1;
        let name = '';
        if (/[A-Za-z_]/.test(body[j]!)) {
          while (j < body.length && /[A-Za-z0-9_]/.test(body[j]!)) { name += body[j]!; j++; }
        } else {
          name = body[j]!;
          j++;
        }
        const special = (() => {
          if (name === '?') return state.exitCode.toString();
          if (name === '#') return String(Math.max(0, state.positional.length - 1));
          if (name === '@' || name === '*') return state.positional.slice(1).join(' ');
          if (/^[0-9]+$/.test(name)) return state.positional[parseInt(name, 10)] ?? '';
          return undefined;
        })();
        out += special ?? getVarValue(state, name) ?? '';
        i = j;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
};

const findMatchingBrace = (s: string, openIdx: number): number => {
  let depth = 1;
  let i = openIdx + 1;
  while (i < s.length) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
};

// Apply output redirects to a captured stdout buffer
const applyOutputRedirects = async (
  redirects: Redirect[], stdout: Uint8Array, stderr: Uint8Array,
  state: ShellState, ctx: { runCmdsub: (s: string) => Promise<string> },
): Promise<{ stdout: Uint8Array; stderr: Uint8Array }> => {
  let out = stdout;
  let err = stderr;
  for (const r of redirects) {
    if (r.target) {
      const path = await expandWordToString(r.target, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
      if (r.kind === 'out') {
        if (r.fd === 1) { writeFileText(path, decodeUtf8(out)); out = new Uint8Array(0); }
        else if (r.fd === 2) { writeFileText(path, decodeUtf8(err)); err = new Uint8Array(0); }
      } else if (r.kind === 'append') {
        let existing = '';
        try { existing = readFileText(path); } catch { /* */ }
        if (r.fd === 1) { writeFileText(path, existing + decodeUtf8(out)); out = new Uint8Array(0); }
        else if (r.fd === 2) { writeFileText(path, existing + decodeUtf8(err)); err = new Uint8Array(0); }
      }
    } else if (r.kind === 'dup' && r.fd === 2 && r.targetFd === 1) {
      // 2>&1 — merge stderr into stdout
      out = concat([out, err]);
      err = new Uint8Array(0);
    } else if (r.kind === 'dup' && r.fd === 1 && r.targetFd === 2) {
      err = concat([err, out]);
      out = new Uint8Array(0);
    }
  }
  return { stdout: out, stderr: err };
};

// ---- Simple command execution ----

const runSimpleCommand = async (cmd: SimpleCommand, state: ShellState, io: IoContext): Promise<ExecResult> => {
  const ctx = { runCmdsub: runCmdsub(state) };

  // Apply assignments (if no command words, persist as exports? — no, just locals)
  if (cmd.words.length === 0) {
    for (const a of cmd.assignments) {
      const v = await expandWordToString(a.value, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
      setVar(state, a.name, v, { append: a.append });
    }
    // Pure assignment counts as success
    return { status: 0 };
  }

  // Expand words
  const expanded: string[] = [];
  for (const w of cmd.words) {
    const items = await expandWord(w, state, { runCmdsub: ctx.runCmdsub });
    for (const it of items) expanded.push(it);
  }
  if (expanded.length === 0) {
    // Words all expanded to nothing
    for (const a of cmd.assignments) {
      const v = await expandWordToString(a.value, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
      setVar(state, a.name, v, { append: a.append });
    }
    return { status: 0 };
  }

  const prog = expanded[0]!;
  const args = expanded.slice(1);

  // Function call?
  const fn = state.functions.get(prog);
  if (fn) {
    pushFrame(state);
    const oldPositional = state.positional;
    state.positional = [prog, ...args];
    try {
      // Assignment prefix applies only within the function scope
      for (const a of cmd.assignments) {
        const v = await expandWordToString(a.value, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
        setVar(state, a.name, v, { local: true, append: a.append });
      }
      const prevReturn = state.returnRequested;
      const prevReturnCode = state.returnRequestedCode;
      state.returnRequested = false;
      await executeCommand(fn.body as AnyCmd, state, io);
      const status = state.returnRequested ? state.returnRequestedCode : state.exitCode;
      state.returnRequested = prevReturn;
      state.returnRequestedCode = prevReturnCode;
      state.exitCode = status;
      return { status };
    } finally {
      popFrame(state);
      state.positional = oldPositional;
    }
  }

  // Apply input redirects
  const stdin = await applyInputRedirects(cmd.redirects, io.stdin, state, ctx);

  // Capture into local buffers
  const localOut: Uint8Array[] = [];
  const localErr: Uint8Array[] = [];
  const localIo: IoContext = {
    stdin,
    captureStdout: { stdout: localOut, stderr: [] },
    captureStderr: { stdout: [], stderr: localErr },
  };

  // Set assignment-prefix vars in a TEMPORARY way: only visible to this command.
  // For external commands, we add them to the snapshot env; for builtins they go
  // on top frame and are unset after.
  const prefixEnv: Record<string, string> = {};
  for (const a of cmd.assignments) {
    const v = await expandWordToString(a.value, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
    prefixEnv[a.name] = v;
  }

  let status = 0;
  try {
    if (isBuiltin(prog)) {
      // Temporarily set prefix vars
      const saved: Record<string, string | undefined> = {};
      for (const k of Object.keys(prefixEnv)) {
        const cur = getVarValue(state, k);
        saved[k] = cur;
        setVar(state, k, prefixEnv[k]!);
      }
      const bio: BuiltinIo = {
        stdout: localOut,
        stderr: localErr,
        stdin,
      };
      try {
        status = await builtins[prog]!(args, state, bio);
      } catch (e) {
        localErr.push(encodeUtf8(`${prog}: ${(e as Error).message}\n`));
        status = 1;
      } finally {
        for (const k of Object.keys(saved)) {
          const v = saved[k];
          if (v === undefined) unsetVar(state, k);
          else setVar(state, k, v);
        }
      }
    } else {
      const resolved = resolveExternal(prog, state);
      if (!resolved) {
        localErr.push(encodeUtf8(`${prog}: command not found\n`));
        status = 127;
      } else {
        // Build child env: exported + prefix
        const env: Record<string, string> = { ...buildEnvSnapshot(state), ...prefixEnv };
        const cp = (globalThis as Record<string, unknown>)['require'] as ((m: string) => { spawnSync: (c: string, a: string[], o?: Record<string, unknown>) => { stdout: Uint8Array; stderr: Uint8Array; status: number } }) | undefined;
        if (!cp) {
          localErr.push(encodeUtf8('require(child_process) unavailable\n'));
          status = 1;
        } else {
          try {
            const mod = cp('child_process');
            const opts: Record<string, unknown> = { env, cwd: state.cwd };
            if (stdin.length > 0) opts['stdin'] = Array.from(stdin);
            const r = mod.spawnSync(resolved, args, opts);
            if (r.stdout && r.stdout.length > 0) localOut.push(r.stdout);
            if (r.stderr && r.stderr.length > 0) localErr.push(r.stderr);
            status = r.status;
          } catch (e) {
            localErr.push(encodeUtf8(`${prog}: ${(e as Error).message}\n`));
            status = 1;
          }
        }
      }
    }
  } finally {
    state.exitCode = status;
  }

  // Apply output redirects
  const redirected = await applyOutputRedirects(cmd.redirects, concat(localOut), concat(localErr), state, ctx);
  if (redirected.stdout.length > 0) emitStdout(redirected.stdout, io);
  if (redirected.stderr.length > 0) emitStderr(redirected.stderr, io);

  return { status };
};

// ---- Compound commands ----

const runIf = async (node: IfStatement, state: ShellState, io: IoContext): Promise<ExecResult> => {
  for (const br of node.branches) {
    await executeCommand(br.condition, state, io);
    if (state.exitCode === 0) {
      await executeCommand(br.body, state, io);
      return { status: state.exitCode };
    }
  }
  if (node.else) {
    await executeCommand(node.else, state, io);
  } else {
    state.exitCode = 0;
  }
  return { status: state.exitCode };
};

const runWhile = async (node: WhileLoop, state: ShellState, io: IoContext): Promise<ExecResult> => {
  let lastStatus = 0;
  while (!state.exitRequested) {
    await executeCommand(node.condition, state, io);
    const condOk = node.until ? state.exitCode !== 0 : state.exitCode === 0;
    if (!condOk) break;
    await executeCommand(node.body, state, io);
    lastStatus = state.exitCode;
    if (state.loopBreakDepth > 0) { state.loopBreakDepth--; break; }
    if (state.loopContinueDepth > 0) { state.loopContinueDepth--; continue; }
    if (state.returnRequested) break;
  }
  state.exitCode = lastStatus;
  return { status: lastStatus };
};

const runFor = async (node: ForLoop, state: ShellState, io: IoContext): Promise<ExecResult> => {
  const ctx = { runCmdsub: runCmdsub(state) };
  // Expand the iteration list
  const items: string[] = [];
  for (const w of node.words) {
    const expanded = await expandWord(w, state, { runCmdsub: ctx.runCmdsub });
    for (const it of expanded) items.push(it);
  }
  let lastStatus = 0;
  for (const v of items) {
    if (state.exitRequested) break;
    setVar(state, node.variable, v);
    await executeCommand(node.body, state, io);
    lastStatus = state.exitCode;
    if (state.loopBreakDepth > 0) { state.loopBreakDepth--; break; }
    if (state.loopContinueDepth > 0) { state.loopContinueDepth--; continue; }
    if (state.returnRequested) break;
  }
  state.exitCode = lastStatus;
  return { status: lastStatus };
};

const matchCasePattern = async (pat: Word, value: string, state: ShellState, ctx: { runCmdsub: (s: string) => Promise<string> }): Promise<boolean> => {
  const expanded = await expandWordToString(pat, state, { noWordSplit: true, noGlob: true, runCmdsub: ctx.runCmdsub });
  // Treat as glob
  const re = new RegExp('^' + expanded
    .replace(/\\(.)/g, '\\$1')
    .replace(/[.+^${}()|[\]]/g, (m) => '\\' + m)
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.') + '$');
  return re.test(value);
};

const runCase = async (node: CaseStatement, state: ShellState, io: IoContext): Promise<ExecResult> => {
  const ctx = { runCmdsub: runCmdsub(state) };
  const word = await expandWordToString(node.word, state, { noWordSplit: true, runCmdsub: ctx.runCmdsub });
  for (const arm of node.arms) {
    let matched = false;
    for (const pat of arm.patterns) {
      if (await matchCasePattern(pat, word, state, ctx)) { matched = true; break; }
    }
    if (matched) {
      await executeCommand(arm.body, state, io);
      if (arm.terminator === ';;') return { status: state.exitCode };
      if (arm.terminator === ';&') {
        // Fall through to next arm without testing
        // Implementation: continue execution into next arm
        const idx = node.arms.indexOf(arm);
        for (let j = idx + 1; j < node.arms.length; j++) {
          await executeCommand(node.arms[j]!.body, state, io);
          if (node.arms[j]!.terminator === ';;') break;
        }
        return { status: state.exitCode };
      }
      if (arm.terminator === ';;&') {
        // Continue testing subsequent arms
        continue;
      }
      return { status: state.exitCode };
    }
  }
  state.exitCode = 0;
  return { status: 0 };
};

const runFunctionDecl = (node: FunctionDecl, state: ShellState): ExecResult => {
  state.functions.set(node.name, { name: node.name, body: node.body });
  state.exitCode = 0;
  return { status: 0 };
};

const runSubshell = async (node: Subshell, state: ShellState, io: IoContext): Promise<ExecResult> => {
  // For v1 of v2 we run in the same state but reset some context.
  // True subshell would clone everything; this approximation suffices for npm install scripts.
  const oldFrame = state.topFrame;
  const oldFunctions = new Map(state.functions);
  try {
    await executeCommand(node.body, state, io);
  } finally {
    state.topFrame = oldFrame;
    state.functions = oldFunctions;
  }
  return { status: state.exitCode };
};

const runGroup = async (node: BraceGroup, state: ShellState, io: IoContext): Promise<ExecResult> => {
  await executeCommand(node.body, state, io);
  return { status: state.exitCode };
};

// ---- Pipeline (concurrent) ----

const runPipeline = async (node: Pipeline, state: ShellState, io: IoContext): Promise<ExecResult> => {
  const { runConcurrentPipeline } = await import('./pipeline-runner');
  return runConcurrentPipeline(node, state, io, {
    executeCommand: (n, s, i) => executeCommand(n, s, i as IoContext),
    runCmdsub,
  });
};

// ---- Top-level dispatch ----

const executeCompoundList = async (list: CompoundList, state: ShellState, io: IoContext): Promise<ExecResult> => {
  for (const item of list.items) {
    if (state.exitRequested) break;
    if (state.loopBreakDepth > 0 || state.loopContinueDepth > 0) break;
    if (state.returnRequested) break;
    await executeCommand(item, state, io);
    // set -e: abort on non-zero unless suppressed (which we don't track in this v1 of v2)
    if (state.setOptions.errexit && state.exitCode !== 0) {
      // Heuristic: don't trip -e for items inside an AndOr that's expected to fail.
      // We simplify by always tripping; future work adds suppression contexts.
      break;
    }
  }
  return { status: state.exitCode };
};

const executeCommand = async (node: AnyCmd, state: ShellState, io: IoContext): Promise<ExecResult> => {
  switch (node.kind) {
    case 'simple': return runSimpleCommand(node, state, io);
    case 'pipeline': return runPipeline(node, state, io);
    case 'andor': return runAndOr(node, state, io);
    case 'seq': return runSeq(node, state, io);
    case 'if': return runIf(node, state, io);
    case 'while': return runWhile(node, state, io);
    case 'for': return runFor(node, state, io);
    case 'cfor': return runCFor(node, state, io);
    case 'case': return runCase(node, state, io);
    case 'func': return runFunctionDecl(node, state);
    case 'subshell': return runSubshell(node, state, io);
    case 'group': return runGroup(node, state, io);
    case 'compound': return executeCompoundList(node, state, io);
    case 'dbracket': {
      const db = node as DoubleBracket;
      const ok = await evalBoolExpr(db.expr, state);
      const code = ok ? 0 : 1;
      state.exitCode = code;
      return { status: code };
    }
    default: {
      state.exitCode = 0;
      return { status: 0 };
    }
  }
};

const runAndOr = async (node: AndOrList, state: ShellState, io: IoContext): Promise<ExecResult> => {
  await executeCommand(node.left, state, io);
  if (node.op === '&&' && state.exitCode !== 0) return { status: state.exitCode };
  if (node.op === '||' && state.exitCode === 0) return { status: 0 };
  await executeCommand(node.right, state, io);
  return { status: state.exitCode };
};

const runSeq = async (node: ListSequence, state: ShellState, io: IoContext): Promise<ExecResult> => {
  for (const item of node.items) {
    if (state.exitRequested) break;
    if (state.loopBreakDepth > 0 || state.loopContinueDepth > 0) break;
    if (state.returnRequested) break;
    await executeCommand(item, state, io);
  }
  return { status: state.exitCode };
};

const runCFor = async (node: CForLoop, state: ShellState, io: IoContext): Promise<ExecResult> => {
  const { evalArith } = await import('./arith');
  evalArith(node.init, state);
  let lastStatus = 0;
  while (!state.exitRequested) {
    const c = evalArith(node.condition, state);
    if (c === 0) break;
    await executeCommand(node.body, state, io);
    lastStatus = state.exitCode;
    if (state.loopBreakDepth > 0) { state.loopBreakDepth--; break; }
    if (state.loopContinueDepth > 0) { state.loopContinueDepth--; /* fall through to step */ }
    if (state.returnRequested) break;
    evalArith(node.update, state);
  }
  state.exitCode = lastStatus;
  return { status: lastStatus };
};

// ---- Public API ----

export const execute = async (ast: CompoundList, state: ShellState): Promise<number> => {
  const io: IoContext = { stdin: new Uint8Array(0) };
  await executeCompoundList(ast, state, io);
  return state.exitRequested ? state.exitRequestedCode : state.exitCode;
};

export { executeCommand, executeCompoundList };
