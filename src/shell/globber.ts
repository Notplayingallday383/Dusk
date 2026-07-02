// Pathname expansion (globbing) — fnmatch-style with optional extglob + globstar.

import type { ShellState } from './scope';

interface FsHandle {
  readdir(path: string): string[];
  stat(path: string): { isFile: boolean; isDirectory: boolean };
  exists(path: string): boolean;
}

const getFs = (): FsHandle | undefined => {
  return (globalThis as Record<string, unknown>)['__fs'] as FsHandle | undefined;
};

// Convert a fnmatch glob segment to a JS RegExp.
const segmentToRegex = (seg: string, opts: { extglob: boolean; nocase: boolean }): RegExp => {
  let re = '^';
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    if (opts.extglob && i + 1 < seg.length && seg[i + 1] === '(' && '?*+@!'.includes(c)) {
      // Extended glob: ?(pat) *(pat) +(pat) @(pat) !(pat)
      const close = findMatchingParen(seg, i + 1);
      if (close === -1) { re += escapeChar(c); i++; continue; }
      const inner = seg.slice(i + 2, close);
      const alts = splitPipes(inner).map((alt) => '(?:' + segmentToRegexBody(alt, opts) + ')').join('|');
      if (c === '?') re += '(?:' + alts + ')?';
      else if (c === '*') re += '(?:' + alts + ')*';
      else if (c === '+') re += '(?:' + alts + ')+';
      else if (c === '@') re += '(?:' + alts + ')';
      else if (c === '!') re += '(?:(?!' + alts + ').)*';
      i = close + 1;
      continue;
    }
    if (c === '*') {
      // ** is handled at segment-walk level, not here
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const close = seg.indexOf(']', i + 1);
      if (close === -1) { re += '\\['; i++; continue; }
      let cls = seg.slice(i + 1, close);
      if (cls.startsWith('!')) cls = '^' + cls.slice(1);
      else if (cls.startsWith('^')) cls = '^' + cls.slice(1);
      re += '[' + cls + ']';
      i = close + 1;
      continue;
    }
    if ('\\'.includes(c) && i + 1 < seg.length) {
      re += escapeChar(seg[i + 1]!);
      i += 2;
      continue;
    }
    re += escapeChar(c);
    i++;
  }
  re += '$';
  return new RegExp(re, opts.nocase ? 'i' : '');
};

const segmentToRegexBody = (seg: string, opts: { extglob: boolean; nocase: boolean }): string => {
  const full = segmentToRegex(seg, opts).source;
  return full.replace(/^\^/, '').replace(/\$$/, '');
};

const escapeChar = (c: string): string => {
  if (/[.+^${}()|[\]\\\/]/.test(c)) return '\\' + c;
  return c;
};

const findMatchingParen = (s: string, openIdx: number): number => {
  let depth = 1;
  for (let i = openIdx + 1; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
};

const splitPipes = (s: string): string[] => {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') depth--;
    else if (s[i] === '|' && depth === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out;
};

const hasGlobMeta = (s: string): boolean => /[*?[\]]/.test(s) || /[?*+@!]\(/.test(s);

const isLikelyHidden = (name: string): boolean => name.startsWith('.');

export const globPattern = (pattern: string, state: ShellState): string[] => {
  if (!hasGlobMeta(pattern)) return [pattern];
  if (state.setOptions.noglob) return [pattern];

  const fs = getFs();
  if (!fs) return [pattern];

  const opts = {
    extglob: state.shopt.extglob,
    nocase: state.shopt.nocaseglob,
    globstar: state.shopt.globstar,
    nullglob: state.shopt.nullglob,
    failglob: state.shopt.failglob,
    dotglob: state.shopt.dotglob,
  };

  const isAbsolute = pattern.startsWith('/');
  const segments = pattern.split('/').filter((s, i, arr) => !(s === '' && i > 0 && i < arr.length - 1));
  const startSegments = isAbsolute ? segments.slice(1) : segments;
  const startDir = isAbsolute ? '/' : state.cwd;

  const matches: string[] = [];
  const seen = new Set<string>();
  const pushMatch = (p: string): void => {
    if (!seen.has(p)) { seen.add(p); matches.push(p); }
  };

  const walk = (dir: string, segIdx: number): void => {
    if (segIdx >= startSegments.length) {
      pushMatch(dir === '' ? '/' : dir);
      return;
    }
    const seg = startSegments[segIdx]!;

    if (seg === '**' && opts.globstar) {
      // Match zero or more directories, then continue with remaining
      walk(dir, segIdx + 1);
      try {
        const entries = fs.readdir(dir || '/');
        for (const e of entries) {
          if (!opts.dotglob && isLikelyHidden(e)) continue;
          const sub = (dir === '/' || dir === '' ? '' : dir) + '/' + e;
          try {
            const st = fs.stat(sub);
            if (st.isDirectory) walk(sub, segIdx);
          } catch { /* skip */ }
        }
      } catch { /* skip */ }
      return;
    }

    if (!hasGlobMeta(seg)) {
      const next = dir === '/' ? '/' + seg : (dir === '' ? seg : dir + '/' + seg);
      try {
        if (fs.exists(next)) {
          const isLast = segIdx === startSegments.length - 1;
          if (isLast) pushMatch(next);
          else {
            const st = fs.stat(next);
            if (st.isDirectory) walk(next, segIdx + 1);
          }
        }
      } catch { /* skip */ }
      return;
    }

    try {
      const entries = fs.readdir(dir || '/');
      const re = segmentToRegex(seg, { extglob: opts.extglob, nocase: opts.nocase });
      for (const e of entries) {
        if (!opts.dotglob && isLikelyHidden(e) && !seg.startsWith('.')) continue;
        if (re.test(e)) {
          const next = dir === '/' ? '/' + e : (dir === '' ? e : dir + '/' + e);
          const isLast = segIdx === startSegments.length - 1;
          if (isLast) pushMatch(next);
          else {
            try {
              const st = fs.stat(next);
              if (st.isDirectory) walk(next, segIdx + 1);
            } catch { /* skip */ }
          }
        }
      }
    } catch { /* skip */ }
  };

  walk(startDir, 0);

  if (matches.length === 0) {
    if (opts.failglob) {
      const err = new Error(`no match: ${pattern}`);
      (err as Error & { code?: string }).code = 'ENOMATCH';
      throw err;
    }
    if (opts.nullglob) return [];
    return [pattern];
  }

  matches.sort();
  return matches;
};

// Brace expansion: {a,b,c} → [a, b, c]; {1..5} → [1,2,3,4,5]; {1..10..2}
export const expandBraces = (s: string): string[] => {
  // Find first unescaped { with a matching unescaped } at the same nesting level,
  // and a , or .. inside.
  const open = findBraceOpen(s);
  if (open === -1) return [s];
  const close = findBraceClose(s, open);
  if (close === -1) return [s];
  const inner = s.slice(open + 1, close);
  const prefix = s.slice(0, open);
  const suffix = s.slice(close + 1);

  let alts: string[];
  // {a..z} or {1..10..2}
  const rangeM = /^(-?\w+)\.\.(-?\w+)(?:\.\.(-?\d+))?$/.exec(inner);
  if (rangeM) {
    const [, a, b, stepStr] = rangeM;
    const step = stepStr ? parseInt(stepStr, 10) : 1;
    const aNum = parseInt(a!, 10);
    const bNum = parseInt(b!, 10);
    if (!isNaN(aNum) && !isNaN(bNum) && step !== 0) {
      alts = [];
      const reverse = aNum > bNum;
      const realStep = reverse ? -Math.abs(step) : Math.abs(step);
      for (let v = aNum; reverse ? v >= bNum : v <= bNum; v += realStep) alts.push(String(v));
    } else if (a!.length === 1 && b!.length === 1 && /[A-Za-z]/.test(a!) && /[A-Za-z]/.test(b!)) {
      const aCp = a!.charCodeAt(0);
      const bCp = b!.charCodeAt(0);
      alts = [];
      const reverse = aCp > bCp;
      const realStep = reverse ? -Math.abs(step) : Math.abs(step);
      for (let v = aCp; reverse ? v >= bCp : v <= bCp; v += realStep) alts.push(String.fromCharCode(v));
    } else {
      return [s];
    }
  } else if (inner.includes(',')) {
    // Split alts on top-level commas
    alts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      const c = inner[i]!;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === ',' && depth === 0) { alts.push(inner.slice(start, i)); start = i + 1; }
    }
    alts.push(inner.slice(start));
  } else {
    return [prefix + '{' + inner + '}' + suffix];
  }

  const out: string[] = [];
  for (const alt of alts) {
    const expanded = expandBraces(prefix + alt + suffix);
    for (const e of expanded) out.push(e);
  }
  return out;
};

const findBraceOpen = (s: string): number => {
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === '{') {
      // Check that there's a closing brace with something useful in between
      const close = findBraceClose(s, i);
      if (close === -1) { i++; continue; }
      const inner = s.slice(i + 1, close);
      if (inner.includes(',') || /\.\.(-?\w+)/.test(inner)) return i;
      i++;
      continue;
    }
    i++;
  }
  return -1;
};

const findBraceClose = (s: string, openIdx: number): number => {
  let depth = 1;
  let i = openIdx + 1;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\\') { i += 2; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
};
