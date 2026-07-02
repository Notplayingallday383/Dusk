// Evaluator for `[[ expression ]]` boolean expressions.

import type { BoolExpr, BoolOp, Word } from './ast';
import { expandWordToString } from './expander';
import { setVar, lookupVar, type ShellState } from './scope';

const expand = (w: Word, state: ShellState): Promise<string> =>
  expandWordToString(w, state, { noWordSplit: true, noGlob: true });

const getFs = (): { exists?: (p: string) => boolean; stat?: (p: string) => { isFile: boolean; isDirectory: boolean } } | undefined =>
  (globalThis as Record<string, unknown>)['__fs'] as
    | { exists?: (p: string) => boolean; stat?: (p: string) => { isFile: boolean; isDirectory: boolean } }
    | undefined;

const fsExists = (path: string): boolean => {
  const fs = getFs();
  try { return fs?.exists?.(path) === true; } catch { return false; }
};
const fsStat = (path: string): { isFile: boolean; isDirectory: boolean } | undefined => {
  const fs = getFs();
  try { return fs?.stat?.(path); } catch { return undefined; }
};

const evalUnary = (op: BoolOp, arg: string, state: ShellState): boolean => {
  switch (op) {
    case '-z': return arg.length === 0;
    case '-n': return arg.length > 0;
    case '-e': return fsExists(arg);
    case '-f': return fsExists(arg) && fsStat(arg)?.isFile === true;
    case '-d': return fsExists(arg) && fsStat(arg)?.isDirectory === true;
    case '-r': case '-w': case '-x': case '-s': return fsExists(arg);
    case '-o': {
      // -o OPTNAME → true iff shell option is set. v1: treat unknown as false.
      const opts = state.setOptions as unknown as Record<string, boolean | undefined>;
      return opts[arg] === true;
    }
    case '-v': return lookupVar(state, arg) !== undefined;
    default: return false;
  }
};

// Convert a bash-style glob pattern to an anchored JS RegExp, matching the
// same conventions as case-pattern matching (see executor-v2.matchCasePattern).
const globToAnchoredRegex = (pattern: string): RegExp => {
  let out = '^';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      const n = pattern[i + 1]!;
      if (/[.+^${}()|[\]\\\/]/.test(n)) out += '\\' + n;
      else out += n;
      i += 2;
      continue;
    }
    if (c === '*') { out += '.*'; i++; continue; }
    if (c === '?') { out += '.'; i++; continue; }
    if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) { out += '\\['; i++; continue; }
      let cls = pattern.slice(i + 1, close);
      if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1);
      out += '[' + cls + ']';
      i = close + 1;
      continue;
    }
    if (/[.+^${}()|[\]\\\/]/.test(c)) out += '\\' + c;
    else out += c;
    i++;
  }
  out += '$';
  return new RegExp(out);
};

const globMatch = (str: string, pattern: string): boolean => {
  try { return globToAnchoredRegex(pattern).test(str); }
  catch { return str === pattern; }
};

// Set BASH_REMATCH. Full array support in scope exists, but the expander does
// not yet parse `${BASH_REMATCH[0]}` subscripts. To keep users productive, we
// set both:
//   - BASH_REMATCH as a real array (for future array-subscript expansion)
//   - BASH_REMATCH_0, BASH_REMATCH_1, ... as scalar fallbacks (usable today).
// TODO: bash arrays via ${VAR[N]} — remove scalar fallback when expander lands it.
const setBashRematch = (state: ShellState, matches: string[]): void => {
  setVar(state, 'BASH_REMATCH', matches);
  for (let i = 0; i < matches.length; i++) {
    setVar(state, `BASH_REMATCH_${i}`, matches[i]!);
  }
};

const evalBinary = (op: BoolOp, lhs: string, rhs: string, state: ShellState): boolean => {
  switch (op) {
    case '==': return globMatch(lhs, rhs);
    case '!=': return !globMatch(lhs, rhs);
    case '=~': {
      let re: RegExp;
      try { re = new RegExp(rhs); } catch { return false; }
      const m = re.exec(lhs);
      if (m) {
        setBashRematch(state, [m[0] ?? '', ...m.slice(1).map((s) => s ?? '')]);
        return true;
      }
      return false;
    }
    case '<': return lhs < rhs;
    case '>': return lhs > rhs;
    case '-eq': return parseInt(lhs, 10) === parseInt(rhs, 10);
    case '-ne': return parseInt(lhs, 10) !== parseInt(rhs, 10);
    case '-lt': return parseInt(lhs, 10) <  parseInt(rhs, 10);
    case '-le': return parseInt(lhs, 10) <= parseInt(rhs, 10);
    case '-gt': return parseInt(lhs, 10) >  parseInt(rhs, 10);
    case '-ge': return parseInt(lhs, 10) >= parseInt(rhs, 10);
    case '-ef': case '-nt': case '-ot':
      // TODO: requires inode/mtime support (decisions log #22 — stub to false).
      return false;
    default:
      return false;
  }
};

export const evalBoolExpr = async (e: BoolExpr, state: ShellState): Promise<boolean> => {
  switch (e.kind) {
    case 'bAnd': return (await evalBoolExpr(e.left!, state)) && (await evalBoolExpr(e.right!, state));
    case 'bOr':  return (await evalBoolExpr(e.left!, state)) || (await evalBoolExpr(e.right!, state));
    case 'bNot': return !(await evalBoolExpr(e.left!, state));
    case 'bWord': return (await expand(e.word!, state)).length > 0;
    case 'bUnary': {
      const a = await expand(e.arg!, state);
      return evalUnary(e.op!, a, state);
    }
    case 'bBinary': {
      const lhs = await expand(e.lhs!, state);
      const rhs = await expand(e.rhs!, state);
      return evalBinary(e.op!, lhs, rhs, state);
    }
  }
};

