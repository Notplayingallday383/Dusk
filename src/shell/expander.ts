// Shell v2 word expander.
//
// POSIX expansion pipeline applied to each Word:
//   1. Tilde expansion
//   2. Brace expansion (multiplies word count)
//   3. Parameter expansion ($VAR, ${VAR...})
//   4. Command substitution ($(...), `...`)
//   5. Arithmetic expansion ($((...)))
//   6. Word splitting on IFS for unquoted results
//   7. Pathname expansion (globbing)
//   8. Quote removal

import type { ParamOp, Word, WordPart } from './ast';
import { evalArith } from './arith';
import { expandBraces, globPattern } from './globber';
import { getVarValue, setVar, type ShellState } from './scope';

export interface ExpandContext {
  // If true, expansion is in an "assignment" or "case word" context where
  // word splitting does not happen.
  noWordSplit?: boolean;
  // If true, do not glob the result.
  noGlob?: boolean;
  // Async command-substitution executor. Required for $(cmd) / `cmd` to work.
  runCmdsub?: (script: string) => Promise<string>;
}

const isGlobMeta = (s: string): boolean => /[*?[\]]/.test(s) || /[?*+@!]\(/.test(s);

const getIFS = (state: ShellState): string => {
  const v = getVarValue(state, 'IFS');
  if (v === undefined) return ' \t\n';
  return v;
};

const splitOnIFS = (s: string, ifs: string): string[] => {
  if (s === '') return [];
  if (ifs === '') return [s];
  // Separators: chars in IFS. Whitespace IFS chars are special — runs collapse and surrounding whitespace is trimmed.
  // Non-whitespace IFS chars produce empty fields if adjacent.
  const wsIfs = '';
  const nonWsIfs: string[] = [];
  const wsIfsChars: string[] = [];
  for (let i = 0; i < ifs.length; i++) {
    const c = ifs[i]!;
    if (c === ' ' || c === '\t' || c === '\n') wsIfsChars.push(c);
    else nonWsIfs.push(c);
  }
  const isWs = (c: string): boolean => wsIfsChars.includes(c);
  const isSep = (c: string): boolean => isWs(c) || nonWsIfs.includes(c);

  // Trim leading/trailing whitespace IFS chars
  let start = 0;
  let end = s.length;
  while (start < end && isWs(s[start]!)) start++;
  while (end > start && isWs(s[end - 1]!)) end--;
  const out: string[] = [];
  let buf = '';
  let i = start;
  while (i < end) {
    const c = s[i]!;
    if (isSep(c)) {
      out.push(buf);
      buf = '';
      i++;
      if (isWs(c)) {
        while (i < end && isWs(s[i]!)) i++;
      }
    } else {
      buf += c;
      i++;
    }
  }
  out.push(buf);
  return out;
};

const indirectLookup = (state: ShellState, name: string): string | undefined => {
  const ref = getVarValue(state, name);
  if (ref === undefined) return undefined;
  return getVarValue(state, ref);
};

const lookupSpecial = (name: string, state: ShellState): string | null => {
  if (name === '?') return state.exitCode.toString();
  if (name === '#') {
    const n = Math.max(0, state.positional.length - 1);
    return n.toString();
  }
  if (name === '@' || name === '*') return state.positional.slice(1).join(' ');
  if (name === '$') {
    const g = globalThis as Record<string, unknown>;
    const p = g['process'] as { pid?: number } | undefined;
    return String(p?.pid ?? 0);
  }
  if (name === '!') return '';
  if (name === '0') return state.positional[0] ?? state.scriptName;
  if (name === '_') return '';
  if (name === '-') {
    let s = '';
    if (state.setOptions.errexit) s += 'e';
    if (state.setOptions.nounset) s += 'u';
    if (state.setOptions.xtrace) s += 'x';
    return s;
  }
  if (/^[0-9]+$/.test(name)) {
    const idx = parseInt(name, 10);
    return state.positional[idx] ?? '';
  }
  return null;
};

// Convert a glob-style pattern from ${VAR#pat} into a regex
const globPatternToRegex = (pattern: string, anchored: 'prefix' | 'suffix' | 'full', longest: boolean): RegExp => {
  let body = '';
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === '\\' && i + 1 < pattern.length) {
      body += escapeRegex(pattern[i + 1]!);
      i += 2;
      continue;
    }
    if (c === '*') {
      body += longest ? '.*' : '.*?';
      i++;
      continue;
    }
    if (c === '?') { body += '.'; i++; continue; }
    if (c === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close === -1) { body += '\\['; i++; continue; }
      let cls = pattern.slice(i + 1, close);
      if (cls.startsWith('!') || cls.startsWith('^')) cls = '^' + cls.slice(1);
      body += '[' + cls + ']';
      i = close + 1;
      continue;
    }
    body += escapeRegex(c);
    i++;
  }
  if (anchored === 'prefix') return new RegExp('^' + body);
  if (anchored === 'suffix') return new RegExp(body + '$');
  return new RegExp('^' + body + '$');
};

const escapeRegex = (c: string): string => /[.+^${}()|[\]\\\/]/.test(c) ? '\\' + c : c;

const applyParamOp = async (
  value: string | undefined,
  op: ParamOp,
  state: ShellState,
  ctx: ExpandContext,
  name: string,
): Promise<string> => {
  const isNullOrUnset = value === undefined || (op.colon && value === '');
  const isUnset = value === undefined;

  const expandSubword = async (w: Word | undefined): Promise<string> => {
    if (!w) return '';
    const parts = await expandWordToString(w, state, ctx);
    return parts;
  };

  switch (op.op) {
    case 'default':
      return isNullOrUnset ? await expandSubword(op.pattern) : (value ?? '');
    case 'alt':
      return isNullOrUnset ? '' : (await expandSubword(op.pattern));
    case 'assign': {
      if (isNullOrUnset) {
        const v = await expandSubword(op.pattern);
        setVar(state, name, v);
        return v;
      }
      return value ?? '';
    }
    case 'error': {
      if (isNullOrUnset) {
        const msg = await expandSubword(op.pattern);
        throw new Error(`${name}: ${msg || 'parameter null or not set'}`);
      }
      return value ?? '';
    }
    case 'length':
      return String((value ?? '').length);
    case 'prefixShort':
    case 'prefixLong': {
      if (value === undefined) return '';
      const pat = await expandSubword(op.pattern);
      const re = globPatternToRegex(pat, 'prefix', op.op === 'prefixLong');
      return value.replace(re, '');
    }
    case 'suffixShort':
    case 'suffixLong': {
      if (value === undefined) return '';
      const pat = await expandSubword(op.pattern);
      const re = globPatternToRegex(pat, 'suffix', op.op === 'suffixLong');
      return value.replace(re, '');
    }
    case 'replaceFirst':
    case 'replaceAll':
    case 'replacePrefix':
    case 'replaceSuffix': {
      if (value === undefined) return '';
      const pat = await expandSubword(op.pattern);
      const repl = await expandSubword(op.replacement);
      const anchored: 'prefix' | 'suffix' | 'full' =
        op.op === 'replacePrefix' ? 'prefix' :
        op.op === 'replaceSuffix' ? 'suffix' : 'full';
      const re = anchored === 'full'
        ? globPatternToRegex(pat, 'full', true)
        : globPatternToRegex(pat, anchored, true);
      if (op.op === 'replaceAll') {
        const src = re.source;
        const globalRe = new RegExp(src, 'g');
        return value.replace(globalRe, repl);
      }
      return value.replace(re, repl);
    }
    case 'substring': {
      const v = value ?? '';
      const offset = op.offset ? evalArith(op.offset, state) : 0;
      const len = op.length ? evalArith(op.length, state) : v.length;
      const start = offset < 0 ? Math.max(0, v.length + offset) : Math.min(offset, v.length);
      const end = len < 0 ? Math.max(start, v.length + len) : Math.min(start + len, v.length);
      return v.slice(start, end);
    }
    case 'indirect': {
      const target = value ?? '';
      return getVarValue(state, target) ?? '';
    }
    case 'upperFirst': {
      if (!value) return '';
      return value.charAt(0).toUpperCase() + value.slice(1);
    }
    case 'upperAll':
      return (value ?? '').toUpperCase();
    case 'lowerFirst': {
      if (!value) return '';
      return value.charAt(0).toLowerCase() + value.slice(1);
    }
    case 'lowerAll':
      return (value ?? '').toLowerCase();
  }
};

const expandPart = async (
  part: WordPart,
  state: ShellState,
  ctx: ExpandContext,
): Promise<{ text: string; quoted: boolean }> => {
  switch (part.kind) {
    case 'lit':
      return { text: part.text ?? '', quoted: false };
    case 'sq':
      return { text: part.text ?? '', quoted: true };
    case 'ansi':
      return { text: part.text ?? '', quoted: true };
    case 'dq': {
      let s = '';
      for (const p of part.parts ?? []) {
        const r = await expandPart(p, state, ctx);
        s += r.text;
      }
      return { text: s, quoted: true };
    }
    case 'tilde': {
      const home = part.user
        ? getVarValue(state, `HOME_${part.user}`) ?? `/home/${part.user}`
        : (getVarValue(state, 'HOME') ?? '/home/user');
      return { text: home, quoted: false };
    }
    case 'var': {
      const name = part.name!;
      let value: string | undefined;
      const special = lookupSpecial(name, state);
      if (special !== null) value = special;
      else value = getVarValue(state, name);
      if (part.paramOp) {
        const result = await applyParamOp(value, part.paramOp, state, ctx, name);
        return { text: result, quoted: false };
      }
      // Nounset check
      if (value === undefined && state.setOptions.nounset && !/^[0-9?#@*!$_-]$/.test(name)) {
        throw new Error(`${name}: unbound variable`);
      }
      return { text: value ?? '', quoted: false };
    }
    case 'cmdsub': {
      if (!ctx.runCmdsub) {
        // No executor wired — return empty (best-effort)
        return { text: '', quoted: false };
      }
      const out = await ctx.runCmdsub(part.text ?? '');
      // Strip trailing newlines per POSIX
      return { text: out.replace(/\n+$/, ''), quoted: false };
    }
    case 'arith': {
      const v = evalArith(part.arithExpr!, state);
      return { text: String(v), quoted: false };
    }
    case 'brace':
    case 'glob':
      return { text: '', quoted: false };
  }
};

// Expand a word to a single string (no splitting/globbing). Used for assignment RHS,
// case word, [[ ]] operands, heredoc patterns.
export const expandWordToString = async (word: Word, state: ShellState, ctx: ExpandContext = {}): Promise<string> => {
  let out = '';
  for (const part of word) {
    const r = await expandPart(part, state, ctx);
    out += r.text;
  }
  return out;
};

// Full expansion: brace → param/cmd/arith → split → glob → quote-remove.
// Returns an array of final strings.
export const expandWord = async (word: Word, state: ShellState, ctx: ExpandContext = {}): Promise<string[]> => {
  // Special case: empty word
  if (word.length === 0) return [''];

  // Step 1: tilde + param/cmd/arith expansion, tracking quoted segments.
  // Output: an array of (text, quoted) segments.
  const segments: { text: string; quoted: boolean }[] = [];
  for (const part of word) {
    const r = await expandPart(part, state, ctx);
    segments.push(r);
  }
  // Concatenate to a single string, but remember a parallel array of which positions were quoted.
  let joined = '';
  let quotedMask: boolean[] = [];
  for (const seg of segments) {
    for (let i = 0; i < seg.text.length; i++) {
      joined += seg.text[i];
      quotedMask.push(seg.quoted);
    }
  }

  // Step 2: brace expansion. Run on the joined string before splitting.
  // Note: brace expansion happens BEFORE param expansion in POSIX, but in practice
  // bash applies brace expansion to the raw word; doing it here on the expanded
  // text is the simpler approximation and covers most cases.
  // To avoid mangling the quoted mask we only run brace expansion if joined has braces.
  let braced: string[];
  if (joined.includes('{')) braced = expandBraces(joined);
  else braced = [joined];

  // Step 3: word splitting on IFS for the unquoted parts.
  let split: string[];
  if (ctx.noWordSplit || quotedMask.every(Boolean)) {
    split = braced;
  } else {
    split = [];
    const ifs = getIFS(state);
    for (const b of braced) {
      // We re-derive the quoted mask conservatively for the post-brace string.
      // For correctness on $@/$* in unquoted contexts we'd need more careful tracking;
      // this approximation splits the whole string on IFS.
      split.push(...splitOnIFS(b, ifs));
    }
    if (split.length === 0) split = [];
  }

  // Step 4: pathname expansion
  if (ctx.noGlob || !state.shopt) {
    return split;
  }
  const expanded: string[] = [];
  for (const s of split) {
    if (s === '' || !isGlobMeta(s)) {
      expanded.push(s);
      continue;
    }
    try {
      const matches = globPattern(s, state);
      for (const m of matches) expanded.push(m);
    } catch (e) {
      throw e;
    }
  }
  return expanded;
};
