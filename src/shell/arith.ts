// Arithmetic ($((expr))) evaluator. Pratt parser over a small tokenizer.

import type { ArithExpr } from './ast';
import { getVarValue, setVar, type ShellState } from './scope';

type TokenKind =
  | 'num' | 'name' | 'lparen' | 'rparen' | 'op' | 'eof'
  | 'comma' | 'question' | 'colon';

interface Token { kind: TokenKind; text: string; pos: number; }

const tokenize = (src: string): Token[] => {
  const toks: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (/[0-9]/.test(c)) {
      let j = i;
      // Hex / octal / decimal
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X')) {
        j = i + 2;
        while (j < src.length && /[0-9a-fA-F]/.test(src[j]!)) j++;
      } else {
        while (j < src.length && /[0-9]/.test(src[j]!)) j++;
      }
      toks.push({ kind: 'num', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j]!)) j++;
      toks.push({ kind: 'name', text: src.slice(i, j), pos: i });
      i = j;
      continue;
    }
    if (c === '(') { toks.push({ kind: 'lparen', text: '(', pos: i }); i++; continue; }
    if (c === ')') { toks.push({ kind: 'rparen', text: ')', pos: i }); i++; continue; }
    if (c === ',') { toks.push({ kind: 'comma', text: ',', pos: i }); i++; continue; }
    if (c === '?') { toks.push({ kind: 'question', text: '?', pos: i }); i++; continue; }
    if (c === ':') { toks.push({ kind: 'colon', text: ':', pos: i }); i++; continue; }
    // Operators (longest first)
    const tryOp = (s: string): boolean => {
      if (src.slice(i, i + s.length) === s) {
        toks.push({ kind: 'op', text: s, pos: i });
        i += s.length;
        return true;
      }
      return false;
    };
    if (tryOp('**=')) continue;
    if (tryOp('<<=')) continue;
    if (tryOp('>>=')) continue;
    if (tryOp('**')) continue;
    if (tryOp('<<')) continue;
    if (tryOp('>>')) continue;
    if (tryOp('<=')) continue;
    if (tryOp('>=')) continue;
    if (tryOp('==')) continue;
    if (tryOp('!=')) continue;
    if (tryOp('&&')) continue;
    if (tryOp('||')) continue;
    if (tryOp('++')) continue;
    if (tryOp('--')) continue;
    if (tryOp('+=')) continue;
    if (tryOp('-=')) continue;
    if (tryOp('*=')) continue;
    if (tryOp('/=')) continue;
    if (tryOp('%=')) continue;
    if (tryOp('&=')) continue;
    if (tryOp('|=')) continue;
    if (tryOp('^=')) continue;
    if ('+-*/%&|^~!<>='.includes(c)) {
      toks.push({ kind: 'op', text: c, pos: i });
      i++;
      continue;
    }
    throw new Error(`arith: unexpected character '${c}' at ${i}`);
  }
  toks.push({ kind: 'eof', text: '', pos: i });
  return toks;
};

// Pratt precedence table
const PREFIX: Record<string, number> = {
  '+': 14, '-': 14, '!': 14, '~': 14, '++': 15, '--': 15,
};

const INFIX: Record<string, { lbp: number; rbp: number; assoc: 'l' | 'r' }> = {
  ',': { lbp: 1, rbp: 1, assoc: 'l' },
  '=':  { lbp: 2, rbp: 1, assoc: 'r' },
  '+=': { lbp: 2, rbp: 1, assoc: 'r' },
  '-=': { lbp: 2, rbp: 1, assoc: 'r' },
  '*=': { lbp: 2, rbp: 1, assoc: 'r' },
  '/=': { lbp: 2, rbp: 1, assoc: 'r' },
  '%=': { lbp: 2, rbp: 1, assoc: 'r' },
  '<<=': { lbp: 2, rbp: 1, assoc: 'r' },
  '>>=': { lbp: 2, rbp: 1, assoc: 'r' },
  '&=': { lbp: 2, rbp: 1, assoc: 'r' },
  '|=': { lbp: 2, rbp: 1, assoc: 'r' },
  '^=': { lbp: 2, rbp: 1, assoc: 'r' },
  '||': { lbp: 4, rbp: 4, assoc: 'l' },
  '&&': { lbp: 5, rbp: 5, assoc: 'l' },
  '|':  { lbp: 6, rbp: 6, assoc: 'l' },
  '^':  { lbp: 7, rbp: 7, assoc: 'l' },
  '&':  { lbp: 8, rbp: 8, assoc: 'l' },
  '==': { lbp: 9, rbp: 9, assoc: 'l' },
  '!=': { lbp: 9, rbp: 9, assoc: 'l' },
  '<':  { lbp: 10, rbp: 10, assoc: 'l' },
  '<=': { lbp: 10, rbp: 10, assoc: 'l' },
  '>':  { lbp: 10, rbp: 10, assoc: 'l' },
  '>=': { lbp: 10, rbp: 10, assoc: 'l' },
  '<<': { lbp: 11, rbp: 11, assoc: 'l' },
  '>>': { lbp: 11, rbp: 11, assoc: 'l' },
  '+':  { lbp: 12, rbp: 12, assoc: 'l' },
  '-':  { lbp: 12, rbp: 12, assoc: 'l' },
  '*':  { lbp: 13, rbp: 13, assoc: 'l' },
  '/':  { lbp: 13, rbp: 13, assoc: 'l' },
  '%':  { lbp: 13, rbp: 13, assoc: 'l' },
  '**': { lbp: 16, rbp: 15, assoc: 'r' },
};

class Parser {
  private i = 0;
  constructor(private toks: Token[]) {}
  private peek(): Token { return this.toks[this.i]!; }
  private next(): Token { return this.toks[this.i++]!; }
  parseExpr(rbp: number = 0): ArithExpr {
    let left = this.nud(this.next());
    while (true) {
      const tok = this.peek();
      if (tok.kind === 'eof' || tok.kind === 'rparen' || tok.kind === 'colon') break;
      if (tok.kind === 'question') {
        if (rbp >= 3) break;
        this.next();
        const thenE = this.parseExpr(0);
        if (this.peek().kind !== 'colon') throw new Error('arith: expected : in ternary');
        this.next();
        const elseE = this.parseExpr(2);
        left = { kind: 'ternary', cond: left, then: thenE, else: elseE };
        continue;
      }
      if (tok.kind === 'op' && (tok.text === '++' || tok.text === '--')) {
        // Postfix
        this.next();
        left = { kind: tok.text === '++' ? 'postInc' : 'postDec', left };
        continue;
      }
      const info = INFIX[tok.text];
      if (!info || info.lbp <= rbp) break;
      this.next();
      const right = this.parseExpr(info.assoc === 'r' ? info.rbp - 1 : info.rbp);
      if (tok.text === ',') {
        left = { kind: 'binary', op: ',', left, right };
      } else if (info.rbp === 1 && tok.text.endsWith('=') && tok.text !== '==' && tok.text !== '<=' && tok.text !== '>=' && tok.text !== '!=') {
        left = { kind: 'assign', op: tok.text, left, right };
      } else {
        left = { kind: 'binary', op: tok.text, left, right };
      }
    }
    return left;
  }
  private nud(tok: Token): ArithExpr {
    if (tok.kind === 'num') {
      const v = tok.text.startsWith('0x') || tok.text.startsWith('0X')
        ? parseInt(tok.text.slice(2), 16)
        : parseInt(tok.text, 10);
      return { kind: 'num', value: v };
    }
    if (tok.kind === 'name') {
      return { kind: 'var', name: tok.text };
    }
    if (tok.kind === 'lparen') {
      const e = this.parseExpr(0);
      if (this.peek().kind !== 'rparen') throw new Error('arith: expected )');
      this.next();
      return e;
    }
    if (tok.kind === 'op') {
      if (tok.text === '++' || tok.text === '--') {
        const operand = this.parseExpr(PREFIX[tok.text]!);
        return { kind: tok.text === '++' ? 'preInc' : 'preDec', left: operand };
      }
      const rbp = PREFIX[tok.text];
      if (rbp !== undefined) {
        const operand = this.parseExpr(rbp);
        return { kind: 'unary', op: tok.text, left: operand };
      }
    }
    throw new Error(`arith: unexpected token '${tok.text}'`);
  }
}

export const parseArith = (src: string): ArithExpr => {
  const p = new Parser(tokenize(src));
  return p.parseExpr(0);
};

const coerce = (s: string | undefined): number => {
  if (!s) return 0;
  const t = s.trim();
  if (t === '') return 0;
  if (t.startsWith('0x') || t.startsWith('0X')) return parseInt(t.slice(2), 16);
  if (/^0[0-7]+$/.test(t)) return parseInt(t, 8);
  const n = parseFloat(t);
  return isNaN(n) ? 0 : Math.trunc(n);
};

const readVar = (state: ShellState, name: string): number => coerce(getVarValue(state, name));
const writeVar = (state: ShellState, name: string, n: number): void => {
  setVar(state, name, String(n), { integer: true });
};

export const evalArith = (expr: ArithExpr, state: ShellState): number => {
  switch (expr.kind) {
    case 'num': return Number(expr.value);
    case 'var': return readVar(state, expr.name!);
    case 'unary': {
      const v = evalArith(expr.left!, state);
      switch (expr.op) {
        case '+': return v;
        case '-': return -v;
        case '!': return v === 0 ? 1 : 0;
        case '~': return ~v;
      }
      return 0;
    }
    case 'preInc': {
      const lv = expr.left!;
      const v = evalArith(lv, state) + 1;
      if (lv.kind === 'var') writeVar(state, lv.name!, v);
      return v;
    }
    case 'preDec': {
      const lv = expr.left!;
      const v = evalArith(lv, state) - 1;
      if (lv.kind === 'var') writeVar(state, lv.name!, v);
      return v;
    }
    case 'postInc': {
      const lv = expr.left!;
      const v = evalArith(lv, state);
      if (lv.kind === 'var') writeVar(state, lv.name!, v + 1);
      return v;
    }
    case 'postDec': {
      const lv = expr.left!;
      const v = evalArith(lv, state);
      if (lv.kind === 'var') writeVar(state, lv.name!, v - 1);
      return v;
    }
    case 'ternary': {
      const c = evalArith(expr.cond!, state);
      return c !== 0 ? evalArith(expr.then!, state) : evalArith(expr.else!, state);
    }
    case 'assign': {
      const lv = expr.left!;
      if (lv.kind !== 'var') throw new Error('arith: assignment to non-variable');
      let v = evalArith(expr.right!, state);
      if (expr.op !== '=') {
        const cur = readVar(state, lv.name!);
        switch (expr.op) {
          case '+=': v = cur + v; break;
          case '-=': v = cur - v; break;
          case '*=': v = cur * v; break;
          case '/=': v = Math.trunc(cur / v); break;
          case '%=': v = cur % v; break;
          case '<<=': v = cur << v; break;
          case '>>=': v = cur >> v; break;
          case '&=': v = cur & v; break;
          case '|=': v = cur | v; break;
          case '^=': v = cur ^ v; break;
        }
      }
      writeVar(state, lv.name!, v);
      return v;
    }
    case 'binary': {
      const a = evalArith(expr.left!, state);
      // Short-circuit operators
      if (expr.op === '&&') return a !== 0 && evalArith(expr.right!, state) !== 0 ? 1 : 0;
      if (expr.op === '||') return a !== 0 || evalArith(expr.right!, state) !== 0 ? 1 : 0;
      const b = evalArith(expr.right!, state);
      switch (expr.op) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return Math.trunc(a / b);
        case '%': return a % b;
        case '**': return Math.pow(a, b);
        case '<<': return a << b;
        case '>>': return a >> b;
        case '&': return a & b;
        case '|': return a | b;
        case '^': return a ^ b;
        case '==': return a === b ? 1 : 0;
        case '!=': return a !== b ? 1 : 0;
        case '<': return a < b ? 1 : 0;
        case '<=': return a <= b ? 1 : 0;
        case '>': return a > b ? 1 : 0;
        case '>=': return a >= b ? 1 : 0;
        case ',': return b;
      }
      return 0;
    }
  }
  return 0;
};

export const evalArithString = (src: string, state: ShellState): number => {
  return evalArith(parseArith(src), state);
};
