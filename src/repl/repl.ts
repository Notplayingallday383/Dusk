import type { DuskRunner } from '../host/runner';

export interface DuskRepl {
  feed(line: string): Promise<void>;
}

const isExpression = (src: string): boolean => {
  const t = src.trim();
  if (/^\s*(const|let|var|function|class|if|for|while|switch|return|throw|try|do|import|export)\b/.test(t)) return false;
  if (/^\s*\{/.test(t)) return false;
  return true;
};

const splitLeadingInit = (rhs: string): { init: string; rest: string } => {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < rhs.length; i++) {
    const c = rhs[i]!;
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return { init: rhs.slice(0, i), rest: rhs.slice(i + 1) };
  }
  return { init: rhs, rest: '' };
};

const hasTopLevelSemicolon = (src: string): boolean => {
  const t = src.replace(/;\s*$/, '');
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ';' && depth === 0) return true;
  }
  return false;
};

const persistDeclaration = (
  src: string,
): { decl: string; rest: string; multi: boolean } | null => {
  const m = /^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([\s\S]+?);?\s*$/.exec(src);
  if (!m) return null;
  const name = m[1]!;
  const rhs = m[2]!;
  const { init, rest } = splitLeadingInit(rhs);
  const decl =
    'globalThis.' + name + ' = (' + init + '\n);\nconst ' + name + ' = globalThis.' + name + ';';
  const trimmedRest = rest.trim();
  return { decl, rest: trimmedRest, multi: hasTopLevelSemicolon(trimmedRest) };
};

export const startRepl = (runner: DuskRunner, write: (text: string) => void): DuskRepl => {
  return {
    feed: async (line: string): Promise<void> => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const persisted = persistDeclaration(trimmed);
      const body = isExpression(trimmed)
        ? 'globalThis.__replResult = (' + trimmed + '\n);'
        : persisted !== null
          ? persisted.rest === ''
            ? persisted.decl + '\nglobalThis.__replResult = undefined;'
            : persisted.multi
              ? persisted.decl + '\n' + persisted.rest + '\nglobalThis.__replResult = undefined;'
              : persisted.decl +
                '\nglobalThis.__replResult = (' +
                persisted.rest +
                '\n);'
          : trimmed + '\nglobalThis.__replResult = undefined;';
      const code =
        'try {' +
        body +
        ' const __v = await Promise.resolve(globalThis.__replResult);' +
        ' console.log(typeof __v === "undefined" ? "undefined" : String(__v));' +
        ' } catch (e) { console.error(String(e)); }';
      await runner.run(code);
      void write;
    },
  };
};
