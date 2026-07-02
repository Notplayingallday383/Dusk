export type ShellToken =
  | { type: 'word'; value: string }
  | { type: 'op'; value: ';' | '&&' | '||' | '|' | '>' | '>>' | '<' };

export class TokenizeError extends Error {
  constructor(msg: string) { super(msg); this.name = 'TokenizeError'; }
}

export const tokenize = (input: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  let i = 0;
  const len = input.length;

  const isOp = (start: number): { op: ';' | '&&' | '||' | '|' | '>' | '>>' | '<'; length: number } | null => {
    const rest = input.slice(start);
    if (rest.startsWith('&&')) return { op: '&&', length: 2 };
    if (rest.startsWith('||')) return { op: '||', length: 2 };
    if (rest.startsWith('>>')) return { op: '>>', length: 2 };
    if (rest.startsWith(';')) return { op: ';', length: 1 };
    if (rest.startsWith('|')) return { op: '|', length: 1 };
    if (rest.startsWith('>')) return { op: '>', length: 1 };
    if (rest.startsWith('<')) return { op: '<', length: 1 };
    return null;
  };

  while (i < len) {
    const c = input[i]!;
    if (/\s/.test(c)) { i++; continue; }

    const op = isOp(i);
    if (op) {
      tokens.push({ type: 'op', value: op.op });
      i += op.length;
      continue;
    }

    let word = '';
    let produced = false;
    while (i < len && !/\s/.test(input[i]!) && !isOp(i)) {
      const ch = input[i]!;
      if (ch === "'") {
        i++;
        while (i < len && input[i] !== "'") { word += input[i]!; i++; }
        if (i >= len) throw new TokenizeError('Unterminated quoted string');
        i++;
        produced = true;
      } else if (ch === '"') {
        i++;
        while (i < len && input[i] !== '"') {
          if (input[i] === '\\') {
            if (i + 1 >= len) throw new TokenizeError('Unterminated quoted string');
            i++;
            word += input[i]!;
            i++;
            continue;
          }
          word += input[i]!;
          i++;
        }
        if (i >= len) throw new TokenizeError('Unterminated quoted string');
        i++;
        produced = true;
      } else if (ch === '\\') {
        if (i + 1 >= len) throw new TokenizeError('Trailing backslash');
        i++;
        word += input[i]!;
        i++;
      } else {
        word += ch;
        i++;
      }
    }
    if (word || produced) tokens.push({ type: 'word', value: word });
  }

  return tokens;
};
