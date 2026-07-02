// Shell v2 builtins.

import { evalArithString } from './arith';
import {
  buildEnvSnapshot, getVarValue, lookupVar, pushFrame, popFrame, setVar, unsetVar,
  type ShellState,
} from './scope';
import { streamingBuiltins as _streamingBuiltins, type StreamingBuiltin } from './streaming-builtins';
import { createPipeChannel } from './pipe-channel';

export interface BuiltinIo {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
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

const normPath = (p: string): string => {
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return '/' + parts.join('/');
};

const writeOut = (io: BuiltinIo, s: string): void => { io.stdout.push(encodeUtf8(s)); };
const writeErr = (io: BuiltinIo, s: string): void => { io.stderr.push(encodeUtf8(s)); };
void writeErr;

export type Builtin = (args: string[], state: ShellState, io: BuiltinIo) => Promise<number> | number;

// ---- printf format ----

const parsePrintfArg = (fmt: string, args: string[]): { out: string; consumed: number } => {
  let out = '';
  let consumed = 0;
  let i = 0;
  const next = (): string => args[consumed++] ?? '';
  while (i < fmt.length) {
    const c = fmt[i]!;
    if (c === '\\') {
      const n = fmt[i + 1];
      if (n === undefined) { out += c; i++; continue; }
      switch (n) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case '\\': out += '\\'; break;
        case '0': out += '\0'; break;
        case 'a': out += '\x07'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'v': out += '\v'; break;
        default: out += n; break;
      }
      i += 2;
      continue;
    }
    if (c === '%') {
      if (fmt[i + 1] === '%') { out += '%'; i += 2; continue; }
      // Parse width/precision/spec
      let j = i + 1;
      let flags = '';
      while (j < fmt.length && '-+ #0'.includes(fmt[j]!)) { flags += fmt[j]!; j++; }
      let width = '';
      while (j < fmt.length && /[0-9]/.test(fmt[j]!)) { width += fmt[j]!; j++; }
      let prec = '';
      if (fmt[j] === '.') { j++; while (j < fmt.length && /[0-9]/.test(fmt[j]!)) { prec += fmt[j]!; j++; } }
      const spec = fmt[j];
      if (spec === undefined) { out += fmt.slice(i); break; }
      const arg = next();
      let result = '';
      switch (spec) {
        case 's': result = arg; break;
        case 'd': case 'i': result = String(Math.trunc(Number(arg) || 0)); break;
        case 'u': result = String(Math.trunc(Number(arg) || 0)); break;
        case 'o': result = (Math.trunc(Number(arg) || 0)).toString(8); break;
        case 'x': result = (Math.trunc(Number(arg) || 0)).toString(16); break;
        case 'X': result = (Math.trunc(Number(arg) || 0)).toString(16).toUpperCase(); break;
        case 'f': case 'F': case 'e': case 'E': case 'g': case 'G':
          result = Number(arg).toString(); break;
        case 'c': result = arg.charAt(0); break;
        case 'b': {
          let s = '';
          for (let k = 0; k < arg.length; k++) {
            if (arg[k] === '\\' && k + 1 < arg.length) {
              const nn = arg[k + 1]!;
              switch (nn) {
                case 'n': s += '\n'; break;
                case 't': s += '\t'; break;
                case 'r': s += '\r'; break;
                case '\\': s += '\\'; break;
                case '0': s += '\0'; break;
                default: s += nn; break;
              }
              k++;
            } else s += arg[k];
          }
          result = s;
          break;
        }
        case 'q': result = "'" + arg.replace(/'/g, "'\\''") + "'"; break;
        default: result = ''; break;
      }
      const w = width ? parseInt(width, 10) : 0;
      if (w > result.length) {
        const pad = ' '.repeat(w - result.length);
        result = flags.includes('-') ? result + pad : pad + result;
      }
      out += result;
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return { out, consumed };
};

// ---- test / [ ----

const testEvaluate = (args: string[], state: ShellState): boolean => {
  // Drop trailing "]" if present (for `[`)
  if (args.length > 0 && args[args.length - 1] === ']') args = args.slice(0, -1);
  return evalTestArgs(args, state);
};

const evalTestArgs = (args: string[], state: ShellState): boolean => {
  if (args.length === 0) return false;
  if (args.length === 1) return args[0] !== '';
  // Handle ! at front
  if (args[0] === '!') return !evalTestArgs(args.slice(1), state);
  // Parens
  if (args[0] === '(' && args[args.length - 1] === ')') {
    return evalTestArgs(args.slice(1, -1), state);
  }
  if (args.length === 2) {
    const [op, val] = args;
    if (op === undefined || val === undefined) return false;
    switch (op) {
      case '-z': return val.length === 0;
      case '-n': return val.length > 0;
      case '-e': case '-a': return fsExists(val);
      case '-f': return fsExists(val) && fsStat(val)?.isFile === true;
      case '-d': return fsExists(val) && fsStat(val)?.isDirectory === true;
      case '-r': case '-w': case '-x': case '-s': return fsExists(val);
      case '-b': case '-c': case '-p': case '-S': case '-L': case '-h': case '-g': case '-u': case '-k': case '-t': return false;
      default: return val !== '';
    }
  }
  if (args.length === 3) {
    const [a, op, b] = args;
    if (a === undefined || op === undefined || b === undefined) return false;
    switch (op) {
      case '=': case '==': return a === b;
      case '!=': return a !== b;
      case '<': return a < b;
      case '>': return a > b;
      case '-eq': return parseInt(a, 10) === parseInt(b, 10);
      case '-ne': return parseInt(a, 10) !== parseInt(b, 10);
      case '-lt': return parseInt(a, 10) < parseInt(b, 10);
      case '-le': return parseInt(a, 10) <= parseInt(b, 10);
      case '-gt': return parseInt(a, 10) > parseInt(b, 10);
      case '-ge': return parseInt(a, 10) >= parseInt(b, 10);
      case '-nt': case '-ot': case '-ef': return false;
    }
  }
  // Try splitting on -a / -o
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-a') {
      return evalTestArgs(args.slice(0, i), state) && evalTestArgs(args.slice(i + 1), state);
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-o') {
      return evalTestArgs(args.slice(0, i), state) || evalTestArgs(args.slice(i + 1), state);
    }
  }
  // Fallback: treat full string as a single arg test
  return args.join(' ') !== '';
};

const fsExists = (path: string): boolean => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { exists?: (p: string) => boolean } | undefined;
  try { return fs?.exists?.(path) === true; } catch { return false; }
};
const fsStat = (path: string): { isFile: boolean; isDirectory: boolean } | undefined => {
  const fs = (globalThis as Record<string, unknown>)['__fs'] as { stat?: (p: string) => { isFile: boolean; isDirectory: boolean } } | undefined;
  try { return fs?.stat?.(path); } catch { return undefined; }
};

// ---- [[ ... ]] evaluator ----
/* deprecated: routed through executor 'dbracket' as of 2026-07-01.
 * Kept as reference for the legacy args-based evaluator; not registered. */

const evalExtendedTest = (args: string[], state: ShellState): boolean => {
  // Strip the outer [[ and ]] markers if present
  if (args[0] === '[[') args = args.slice(1);
  if (args[args.length - 1] === ']]') args = args.slice(0, -1);
  // Support && and || at this level
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '||') {
      return evalExtendedTest(args.slice(0, i), state) || evalExtendedTest(args.slice(i + 1), state);
    }
  }
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '&&') {
      return evalExtendedTest(args.slice(0, i), state) && evalExtendedTest(args.slice(i + 1), state);
    }
  }
  return evalTestArgs(args, state);
};

// ---- Builtin registry ----

export const builtins: Record<string, Builtin> = {
  ':': () => 0,
  'true': () => 0,
  'false': () => 1,

  cd: (args, state) => {
    const target = args[0] ?? getVarValue(state, 'HOME') ?? '/';
    let resolved: string;
    if (target === '-') {
      resolved = state.oldPwd;
      writeOut({ stdout: [], stderr: [], stdin: new Uint8Array(0) } as BuiltinIo, resolved + '\n');
    } else {
      resolved = target.startsWith('/') ? target : state.cwd.replace(/\/$/, '') + '/' + target;
    }
    const normalized = normPath(resolved);
    state.oldPwd = state.cwd;
    state.cwd = normalized;
    setVar(state, 'PWD', normalized, { exported: true });
    setVar(state, 'OLDPWD', state.oldPwd, { exported: true });
    // Sync engine cwd
    const proc = (globalThis as Record<string, unknown>)['process'] as { chdir?: (p: string) => void } | undefined;
    try { proc?.chdir?.(normalized); } catch { /* */ }
    return 0;
  },

  pwd: (_args, state, io) => {
    writeOut(io, state.cwd + '\n');
    return 0;
  },

  echo: (args, _state, io) => {
    let newline = true;
    let interpret = false;
    let start = 0;
    while (start < args.length && args[start]!.startsWith('-')) {
      const flag = args[start]!;
      if (flag === '-n') newline = false;
      else if (flag === '-e') interpret = true;
      else if (flag === '-E') interpret = false;
      else break;
      start++;
    }
    let text = args.slice(start).join(' ');
    if (interpret) {
      text = text.replace(/\\(.)/g, (_m, c) => {
        switch (c) {
          case 'n': return '\n';
          case 't': return '\t';
          case 'r': return '\r';
          case '\\': return '\\';
          case '0': return '\0';
          default: return '\\' + c;
        }
      });
    }
    writeOut(io, newline ? text + '\n' : text);
    return 0;
  },

  exit: (args, state) => {
    const code = args.length > 0 ? parseInt(args[0]!, 10) : state.exitCode;
    state.exitRequested = true;
    state.exitRequestedCode = isNaN(code) ? 0 : code;
    return state.exitRequestedCode;
  },

  export: (args, state, io) => {
    if (args.length === 0) {
      const snap = buildEnvSnapshot(state);
      for (const k of Object.keys(snap)) writeOut(io, `export ${k}=${snap[k]}\n`);
      return 0;
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        const v = getVarValue(state, a);
        setVar(state, a, v ?? '', { exported: true });
      } else {
        setVar(state, a.slice(0, eq), a.slice(eq + 1), { exported: true });
      }
    }
    return 0;
  },

  unset: (args, state) => {
    let mode: 'v' | 'f' = 'v';
    let start = 0;
    if (args[0] === '-v') { mode = 'v'; start = 1; }
    else if (args[0] === '-f') { mode = 'f'; start = 1; }
    for (let i = start; i < args.length; i++) {
      const name = args[i]!;
      if (mode === 'f') state.functions.delete(name);
      else unsetVar(state, name);
    }
    return 0;
  },

  env: (_args, state, io) => {
    const snap = buildEnvSnapshot(state);
    for (const k of Object.keys(snap)) writeOut(io, `${k}=${snap[k]}\n`);
    return 0;
  },

  printf: (args, _state, io) => {
    if (args.length === 0) return 0;
    const fmt = args[0]!;
    const rest = args.slice(1);
    if (rest.length === 0) {
      const r = parsePrintfArg(fmt, []);
      writeOut(io, r.out);
      return 0;
    }
    let i = 0;
    while (i < rest.length) {
      const r = parsePrintfArg(fmt, rest.slice(i));
      writeOut(io, r.out);
      i += r.consumed > 0 ? r.consumed : rest.length;
    }
    return 0;
  },

  test: (args, state) => testEvaluate(args, state) ? 0 : 1,
  '[': (args, state) => testEvaluate(args, state) ? 0 : 1,

  read: (args, state, io) => {
    let raw = false;
    let i = 0;
    const names: string[] = [];
    while (i < args.length) {
      const a = args[i]!;
      if (a === '-r') { raw = true; i++; continue; }
      if (a === '-p') { i += 2; continue; }
      if (a === '-a' || a === '-d' || a === '-n' || a === '-N' || a === '-t' || a === '-u') { i += 2; continue; }
      if (a.startsWith('-')) { i++; continue; }
      names.push(a);
      i++;
    }
    const text = decodeUtf8(io.stdin);
    const nlIdx = text.indexOf('\n');
    const line = nlIdx === -1 ? text : text.slice(0, nlIdx);
    if (!raw) {
      // Strip backslash-newline continuations
    }
    if (names.length === 0) names.push('REPLY');
    const ifs = getVarValue(state, 'IFS') ?? ' \t\n';
    const parts = line.split(new RegExp(`[${ifs.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]+`).source ? new RegExp(`[${ifs.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}]+`) : / /);
    for (let j = 0; j < names.length; j++) {
      let value: string;
      if (j === names.length - 1) value = parts.slice(j).join(ifs[0] ?? ' ');
      else value = parts[j] ?? '';
      setVar(state, names[j]!, value);
    }
    return nlIdx === -1 && text.length === 0 ? 1 : 0;
  },

  source: async (args, state, io) => {
    const path = args[0];
    if (!path) { writeErr(io, '.: filename argument required\n'); return 1; }
    try {
      const fs = (globalThis as Record<string, unknown>)['__fs'] as { readFile: (p: string) => string } | undefined;
      if (!fs) { writeErr(io, '.: fs unavailable\n'); return 1; }
      const text = fs.readFile(path);
      const { tokenize } = await import('./tokenizer-v2');
      const { parse } = await import('./parser-v2');
      const { execute } = await import('./executor-v2');
      const { tokens, heredocs } = tokenize(text);
      const ast = parse(tokens, heredocs);
      const oldPos = state.positional;
      state.positional = [path, ...args.slice(1)];
      try {
        await execute(ast, state);
      } finally {
        state.positional = oldPos;
      }
      return state.exitCode;
    } catch (e) {
      writeErr(io, `.: ${(e as Error).message}\n`);
      return 1;
    }
  },

  '.': (args, state, io) => builtins['source']!(args, state, io),

  trap: (args, state, io) => {
    if (args.length === 0) {
      for (const [sig, body] of state.traps) {
        writeOut(io, `trap -- ${JSON.stringify(body ?? '')} ${sig}\n`);
      }
      return 0;
    }
    // trap CMD SIG... | trap - SIG... (reset)
    const first = args[0]!;
    const sigs = args.slice(1);
    if (first === '-') {
      for (const s of sigs) state.traps.delete(s);
    } else {
      for (const s of sigs) state.traps.set(s, first === '' ? null : first);
    }
    return 0;
  },

  shift: (args, state) => {
    const n = args[0] ? parseInt(args[0], 10) : 1;
    if (isNaN(n) || n < 0) return 1;
    const stay = state.positional[0]!;
    const rest = state.positional.slice(1);
    state.positional = [stay, ...rest.slice(n)];
    return 0;
  },

  set: (args, state, io) => {
    if (args.length === 0) {
      // Print all variables in current scope
      const seen = new Set<string>();
      let frame = state.topFrame;
      while (frame) {
        for (const [name, v] of frame.vars) {
          if (!seen.has(name)) {
            seen.add(name);
            const val = Array.isArray(v.value) ? v.value.join(' ') : v.value;
            writeOut(io, `${name}=${val}\n`);
          }
        }
        frame = frame.parent!;
      }
      return 0;
    }
    let i = 0;
    while (i < args.length) {
      const a = args[i]!;
      if (a === '--') { i++; break; }
      if (a.startsWith('-') || a.startsWith('+')) {
        const enable = a.startsWith('-');
        const flags = a.slice(1);
        if (flags === 'o') {
          const opt = args[++i];
          if (opt === 'pipefail') state.setOptions.pipefail = enable;
          else if (opt === 'errexit') state.setOptions.errexit = enable;
          else if (opt === 'nounset') state.setOptions.nounset = enable;
          else if (opt === 'xtrace') state.setOptions.xtrace = enable;
          else if (opt === 'noglob') state.setOptions.noglob = enable;
        } else {
          for (const f of flags) {
            switch (f) {
              case 'e': state.setOptions.errexit = enable; break;
              case 'u': state.setOptions.nounset = enable; break;
              case 'x': state.setOptions.xtrace = enable; break;
              case 'f': state.setOptions.noglob = enable; break;
              case 'C': state.setOptions.noclobber = enable; break;
              case 'a': state.setOptions.allexport = enable; break;
              case 'n': state.setOptions.noexec = enable; break;
            }
          }
        }
        i++;
        continue;
      }
      break;
    }
    // Remaining args become positional
    if (i < args.length) state.positional = [state.positional[0] ?? 'sh', ...args.slice(i)];
    return 0;
  },

  shopt: (args, state, io) => {
    let setMode: '-s' | '-u' | undefined;
    let printOnly = false;
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      if (args[i] === '-s') setMode = '-s';
      else if (args[i] === '-u') setMode = '-u';
      else if (args[i] === '-p' || args[i] === '-q') printOnly = true;
      i++;
    }
    const names = args.slice(i);
    if (names.length === 0) {
      // Print all
      const list: (keyof typeof state.shopt)[] = ['extglob', 'globstar', 'nullglob', 'failglob', 'dotglob', 'nocaseglob', 'nocasematch'];
      for (const name of list) {
        writeOut(io, `${name}\t${state.shopt[name] ? 'on' : 'off'}\n`);
      }
      return 0;
    }
    const shoptAny = state.shopt as unknown as Record<string, boolean>;
    for (const name of names) {
      if (setMode === '-s') shoptAny[name] = true;
      else if (setMode === '-u') shoptAny[name] = false;
      else writeOut(io, `${name}\t${shoptAny[name] ? 'on' : 'off'}\n`);
    }
    void printOnly;
    return 0;
  },

  return: (args, state) => {
    const n = args[0] ? parseInt(args[0], 10) : state.exitCode;
    state.returnRequested = true;
    state.returnRequestedCode = isNaN(n) ? 0 : n;
    return state.returnRequestedCode;
  },

  break: (args, state) => {
    const n = args[0] ? parseInt(args[0], 10) : 1;
    state.loopBreakDepth = isNaN(n) ? 1 : Math.max(1, n);
    return 0;
  },

  continue: (args, state) => {
    const n = args[0] ? parseInt(args[0], 10) : 1;
    state.loopContinueDepth = isNaN(n) ? 1 : Math.max(1, n);
    return 0;
  },

  eval: async (args, state, io) => {
    const text = args.join(' ');
    if (!text) return 0;
    try {
      const { tokenize } = await import('./tokenizer-v2');
      const { parse } = await import('./parser-v2');
      const { execute } = await import('./executor-v2');
      const { tokens, heredocs } = tokenize(text);
      const ast = parse(tokens, heredocs);
      await execute(ast, state);
      return state.exitCode;
    } catch (e) {
      writeErr(io, `eval: ${(e as Error).message}\n`);
      return 1;
    }
  },

  local: (args, state, io) => {
    if (state.topFrame === state.rootFrame) {
      writeErr(io, 'local: can only be used in a function\n');
      return 1;
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq === -1) setVar(state, a, '', { local: true });
      else setVar(state, a.slice(0, eq), a.slice(eq + 1), { local: true });
    }
    return 0;
  },

  readonly: (args, state, io) => {
    if (args.length === 0) {
      // Print readonly vars
      const seen = new Set<string>();
      let frame = state.topFrame;
      while (frame) {
        for (const [name, v] of frame.vars) {
          if (v.readonly && !seen.has(name)) {
            seen.add(name);
            const val = Array.isArray(v.value) ? v.value.join(' ') : v.value;
            writeOut(io, `readonly ${name}=${JSON.stringify(val)}\n`);
          }
        }
        frame = frame.parent!;
      }
      return 0;
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        const v = lookupVar(state, a);
        if (v) v.readonly = true;
        else setVar(state, a, '', { readonly: true });
      } else {
        setVar(state, a.slice(0, eq), a.slice(eq + 1), { readonly: true });
      }
    }
    return 0;
  },

  declare: (args, state, io) => {
    let local = false;
    let exported = false;
    let readonly = false;
    let integer = false;
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) {
      const flag = args[i]!;
      if (flag === '-x') exported = true;
      else if (flag === '-r') readonly = true;
      else if (flag === '-i') integer = true;
      else if (flag === '-a' || flag === '-A') { /* arrays — accept but don't fully implement */ }
      else if (flag === '-l') local = true;
      i++;
    }
    void local;
    if (i >= args.length) {
      // Print all vars
      const seen = new Set<string>();
      let frame = state.topFrame;
      while (frame) {
        for (const [name, v] of frame.vars) {
          if (seen.has(name)) continue;
          seen.add(name);
          const val = Array.isArray(v.value) ? v.value.join(' ') : v.value;
          writeOut(io, `declare ${name}=${JSON.stringify(val)}\n`);
        }
        frame = frame.parent!;
      }
      return 0;
    }
    for (; i < args.length; i++) {
      const a = args[i]!;
      const eq = a.indexOf('=');
      if (eq === -1) setVar(state, a, '', { exported, readonly, integer });
      else setVar(state, a.slice(0, eq), a.slice(eq + 1), { exported, readonly, integer });
    }
    return 0;
  },

  typeset: (args, state, io) => builtins['declare']!(args, state, io),

  alias: (args, state, io) => {
    if (args.length === 0) {
      for (const [name, value] of state.aliases) writeOut(io, `alias ${name}=${JSON.stringify(value)}\n`);
      return 0;
    }
    for (const a of args) {
      const eq = a.indexOf('=');
      if (eq === -1) {
        const v = state.aliases.get(a);
        if (v !== undefined) writeOut(io, `alias ${a}=${JSON.stringify(v)}\n`);
      } else {
        state.aliases.set(a.slice(0, eq), a.slice(eq + 1));
      }
    }
    return 0;
  },

  unalias: (args, state) => {
    for (const a of args) state.aliases.delete(a);
    return 0;
  },

  command: async (args, state, io) => {
    // Skip flags
    let i = 0;
    while (i < args.length && args[i]!.startsWith('-')) i++;
    if (i >= args.length) return 0;
    // Run the remaining as if they were a simple command, bypassing functions/aliases.
    // We do this by reconstructing and executing through eval.
    const cmd = args.slice(i).map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(' ');
    return builtins['eval']!([cmd], state, io) as Promise<number>;
  },

  type: (args, state, io) => {
    for (const a of args) {
      if (state.aliases.has(a)) writeOut(io, `${a} is aliased to '${state.aliases.get(a)}'\n`);
      else if (state.functions.has(a)) writeOut(io, `${a} is a function\n`);
      else if (Object.prototype.hasOwnProperty.call(builtins, a)) writeOut(io, `${a} is a shell builtin\n`);
      else {
        // Try PATH lookup
        const fs = (globalThis as Record<string, unknown>)['__fs'] as { exists?: (p: string) => boolean } | undefined;
        const pathEnv = getVarValue(state, 'PATH') ?? '/bin';
        let found: string | undefined;
        for (const dir of pathEnv.split(':')) {
          if (!dir) continue;
          const cand = (dir.endsWith('/') ? dir : dir + '/') + a;
          try { if (fs?.exists?.(cand)) { found = cand; break; } } catch { /* */ }
        }
        if (found) writeOut(io, `${a} is ${found}\n`);
        else { writeErr(io, `${a}: not found\n`); return 1; }
      }
    }
    return 0;
  },

  let: (args, state) => {
    let last = 0;
    for (const a of args) {
      try { last = evalArithString(a, state); } catch { return 1; }
    }
    state.exitCode = last === 0 ? 1 : 0;
    return last === 0 ? 1 : 0;
  },

  hash: () => 0,
  times: (_args, _state, io) => { writeOut(io, '0m0.000s 0m0.000s\n0m0.000s 0m0.000s\n'); return 0; },
  ulimit: () => 0,
  umask: (args, _state, io) => {
    if (args.length === 0) writeOut(io, '0022\n');
    return 0;
  },
  builtin: async (args, state, io) => {
    if (args.length === 0) return 0;
    const name = args[0]!;
    if (!builtins[name]) { writeErr(io, `builtin: ${name}: not a shell builtin\n`); return 1; }
    return builtins[name]!(args.slice(1), state, io);
  },
  getopts: (args, state, io) => {
    const optstring = args[0];
    const varName = args[1];
    if (!optstring || !varName) return 2;
    const optind = parseInt(getVarValue(state, 'OPTIND') ?? '1', 10);
    if (optind >= state.positional.length) {
      setVar(state, varName, '?');
      return 1;
    }
    const arg = state.positional[optind];
    if (!arg || !arg.startsWith('-') || arg === '--') {
      setVar(state, 'OPTIND', String(optind + 1));
      setVar(state, varName, '?');
      return 1;
    }
    const ch = arg[1]!;
    const colonAfter = optstring.indexOf(ch) !== -1 && optstring[optstring.indexOf(ch) + 1] === ':';
    setVar(state, varName, ch);
    if (colonAfter) {
      setVar(state, 'OPTARG', state.positional[optind + 1] ?? '');
      setVar(state, 'OPTIND', String(optind + 2));
    } else {
      setVar(state, 'OPTIND', String(optind + 1));
    }
    void io;
    return 0;
  },
  wait: () => 0,
  exec: () => 0,    // No-op: full exec replacement is complex; we accept the syntax.
  bg: () => 0,
  fg: () => 0,
  jobs: () => 0,
  disown: () => 0,
  history: () => 0,
  pushd: () => 0,
  popd: () => 0,
  dirs: () => 0,
  caller: () => 1,
  bind: () => 0,
  complete: () => 0,
  compgen: () => 0,
  compopt: () => 0,
};

const adaptStreamingBuiltin = (sb: StreamingBuiltin): Builtin => {
  return async (args, state, io) => {
    const stdin = createPipeChannel(4);
    const stdout = createPipeChannel(64);
    const stderr = createPipeChannel(64);
    if (io.stdin.length > 0) await stdin.write(io.stdin);
    stdin.close();
    const collectOut = (async () => {
      for await (const c of stdout.readable) io.stdout.push(c);
    })();
    const collectErr = (async () => {
      for await (const c of stderr.readable) io.stderr.push(c);
    })();
    let status: number;
    try {
      status = await sb(args, state, {
        stdinStream: stdin.readable,
        writeStdout: stdout.write,
        writeStderr: stderr.write,
        signalEof: stdout.close,
      });
    } finally {
      stdout.close();
      stderr.close();
    }
    await Promise.all([collectOut, collectErr]);
    return status;
  };
};

for (const name of Object.keys(_streamingBuiltins)) {
  // Only register if not already a builtin (avoid clobbering existing entries)
  if (!(name in builtins)) {
    builtins[name] = adaptStreamingBuiltin(_streamingBuiltins[name]!);
  }
}

// Overwrite `true` / `false` with the streaming versions for consistency —
// the streaming versions are no-ops in buffer mode, behavior unchanged.
builtins['true'] = adaptStreamingBuiltin(_streamingBuiltins['true']!);
builtins['false'] = adaptStreamingBuiltin(_streamingBuiltins['false']!);

void pushFrame; void popFrame;

export const isBuiltin = (name: string): boolean => Object.prototype.hasOwnProperty.call(builtins, name);

// Streaming builtins (concurrent pipeline path — plan 4). Distinct signature
// from the classic `Builtin` above: async, chunked stdout, EPIPE-aware.
// Re-exported here so the executor can dispatch by name without a second import.
export { streamingBuiltins } from './streaming-builtins';
export type { StreamingBuiltin, StreamingBuiltinIo } from './streaming-builtins';

export const isStreamingBuiltin = (name: string): boolean =>
  Object.prototype.hasOwnProperty.call(_streamingBuiltins, name);
