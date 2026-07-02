// Shell v2 parser. Builds an AST from the tokenizer output.

import type {
  AnyCmd, ArithExpr, Assignment, CompoundList, ListSequence, Pipeline, AndOrList,
  Redirect, SimpleCommand, Word, WordPart,
  IfStatement, WhileLoop, ForLoop, CForLoop, CaseStatement, FunctionDecl,
  Subshell, BraceGroup, BoolExpr, BoolOp, DoubleBracket,
} from './ast';
import { parseArith } from './arith';
import type { Token, OpKind, KeywordKind } from './tokenizer-v2';

export class ParseError extends Error {
  constructor(msg: string) { super(msg); this.name = 'ParseError'; }
}

class Parser {
  private i = 0;
  private heredocs: Record<number, { body: string; expand: boolean }>;

  constructor(private tokens: Token[], heredocs: Record<number, { body: string; expand: boolean }>) {
    this.heredocs = heredocs;
  }

  private peek(offset = 0): Token | undefined { return this.tokens[this.i + offset]; }
  private next(): Token { const t = this.tokens[this.i++]; if (!t) throw new ParseError('unexpected end of input'); return t; }
  private eof(): boolean { return this.i >= this.tokens.length; }

  private skipNewlines(): void {
    while (!this.eof() && this.peek()!.kind === 'newline') this.i++;
  }

  private isStatementEnd(): boolean {
    if (this.eof()) return true;
    const t = this.peek()!;
    if (t.kind === 'newline') return true;
    if (t.kind === 'op' && (t.op === ';' || t.op === '&')) return true;
    return false;
  }

  private isListTerminator(): boolean {
    if (this.eof()) return true;
    const t = this.peek()!;
    if (t.kind === 'kw') {
      switch (t.kw) {
        case 'fi': case 'then': case 'elif': case 'else':
        case 'done': case 'do':
        case 'esac':
        case '}': case ']]':
          return true;
        default: return false;
      }
    }
    if (t.kind === 'op' && t.op === ')') return true;
    if (t.kind === 'op' && (t.op === ';;' || t.op === ';;&' || t.op === ';&')) return true;
    return false;
  }

  parseProgram(): CompoundList {
    this.skipNewlines();
    return this.parseCompoundList();
  }

  private parseCompoundList(): CompoundList {
    const items: AnyCmd[] = [];
    while (!this.eof() && !this.isListTerminator()) {
      this.skipNewlines();
      if (this.isListTerminator()) break;
      const item = this.parseAndOr();
      items.push(item);
      // Consume separator
      let sep: ';' | '&' | '\n' | null = null;
      while (!this.eof()) {
        const t = this.peek()!;
        if (t.kind === 'op' && t.op === ';') { sep = ';'; this.i++; }
        else if (t.kind === 'op' && t.op === '&') { sep = '&'; this.i++; }
        else if (t.kind === 'newline') { sep = '\n'; this.i++; }
        else break;
      }
      if (sep === null && !this.isListTerminator()) break;
    }
    return { kind: 'compound', items };
  }

  private parseAndOr(): AnyCmd {
    let left: AnyCmd = this.parsePipeline();
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'op') break;
      if (t.op !== '&&' && t.op !== '||') break;
      const op = t.op;
      this.i++;
      this.skipNewlines();
      const right = this.parsePipeline();
      left = { kind: 'andor', left, op, right };
    }
    return left;
  }

  private parsePipeline(): AnyCmd {
    let negated = false;
    if (!this.eof() && this.peek()!.kind === 'kw' && (this.peek() as { kw: KeywordKind }).kw === '!') {
      negated = true;
      this.i++;
    }
    const stages: AnyCmd[] = [this.parseCommand()];
    while (true) {
      const t = this.peek();
      if (!t || t.kind !== 'op') break;
      if (t.op !== '|' && t.op !== '|&') break;
      this.i++;
      this.skipNewlines();
      const next = this.parseCommand();
      // |& is "pipe stdout and stderr"; for v2 we treat it as |  + an implicit 2>&1
      // The redirect is conceptually attached to the LEFT command; defer that nuance.
      stages.push(next);
    }
    if (stages.length === 1 && !negated) return stages[0]!;
    return { kind: 'pipeline', negated, stages };
  }

  private parseCommand(): AnyCmd {
    const t = this.peek();
    if (!t) throw new ParseError('unexpected end of input');

    if (t.kind === 'kw') {
      switch (t.kw) {
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile(false);
        case 'until': return this.parseWhile(true);
        case 'for': return this.parseFor();
        case 'case': return this.parseCase();
        case 'function': return this.parseFunction();
        case '[[': return this.parseExtendedTest();
        default: break;
      }
    }

    if (t.kind === 'op' && t.op === '(') return this.parseSubshell();
    if (t.kind === 'op' && t.op === '{') return this.parseBraceGroup();

    return this.parseSimpleCommand();
  }

  private parseSimpleCommand(): AnyCmd {
    const assignments: Assignment[] = [];
    const words: Word[] = [];
    const redirects: Redirect[] = [];

    let lastIoNumber: number | undefined;
    let sawWord = false;

    while (!this.eof()) {
      const t = this.peek()!;

      if (t.kind === 'newline' || (t.kind === 'op' && (t.op === ';' || t.op === '&' || t.op === '|' || t.op === '||' || t.op === '&&' || t.op === '|&' || t.op === ')' || t.op === ';;' || t.op === ';&' || t.op === ';;&'))) {
        break;
      }
      if (t.kind === 'kw' && this.isListTerminator()) break;

      if (t.kind === 'io_number') {
        lastIoNumber = t.fd;
        this.i++;
        continue;
      }
      if (t.kind === 'op' && this.isRedirectOp(t.op)) {
        this.parseRedirect(redirects, lastIoNumber);
        lastIoNumber = undefined;
        continue;
      }
      if (t.kind === 'heredoc') {
        const idx = this.i;
        this.i++;
        const body = this.heredocs[idx];
        if (body) {
          redirects.push({
            kind: 'heredoc', fd: lastIoNumber ?? t.fd,
            body: body.body, expandHeredoc: body.expand,
          });
        }
        lastIoNumber = undefined;
        continue;
      }

      if (t.kind === 'word') {
        // Detect a function definition: NAME() compound-cmd
        if (!sawWord && t.word.length === 1 && t.word[0]!.kind === 'lit') {
          const next = this.peek(1);
          if (next && next.kind === 'op' && next.op === '(') {
            const nameTok = t;
            this.i += 2; // consume word and '('
            const close = this.peek();
            if (close && close.kind === 'op' && close.op === ')') {
              this.i++;
              this.skipNewlines();
              const body = this.parseCommand();
              return { kind: 'func', name: nameTok.word[0]!.text!, body };
            }
            throw new ParseError(`expected ) after ${nameTok.word[0]!.text}(`);
          }
        }

        // Assignment prefix only valid before any words
        if (!sawWord && t.hasAssignmentPrefix) {
          const t2 = t;
          const litText = t2.word[0]!.text!;
          const eqIdx = litText.indexOf('=');
          const plusEq = litText[eqIdx - 1] === '+';
          const name = plusEq ? litText.slice(0, eqIdx - 1) : litText.slice(0, eqIdx);
          const valLit = litText.slice(eqIdx + 1);
          const restParts = t2.word.slice(1);
          const valueParts: WordPart[] = [];
          if (valLit !== '') valueParts.push({ kind: 'lit', text: valLit });
          for (const rp of restParts) valueParts.push(rp);
          assignments.push({ name, value: valueParts, append: plusEq });
          this.i++;
          continue;
        }

        sawWord = true;
        words.push(t.word);
        this.i++;
        continue;
      }

      // Unknown token in command position — break
      break;
    }

    return { kind: 'simple', assignments, words, redirects };
  }

  private isRedirectOp(op: OpKind): boolean {
    return op === '<' || op === '>' || op === '>>' || op === '<>' || op === '>|' ||
           op === '>&' || op === '<&' || op === '&>' || op === '&>>' || op === '<<<';
  }

  private parseRedirect(redirects: Redirect[], explicitFd?: number): void {
    const t = this.next() as { kind: 'op'; op: OpKind };
    const op = t.op;

    const expectTarget = (): Word => {
      const next = this.peek();
      if (!next || next.kind !== 'word') throw new ParseError(`expected target for redirect ${op}`);
      this.i++;
      return next.word;
    };

    if (op === '<') redirects.push({ kind: 'in', fd: explicitFd ?? 0, target: expectTarget() });
    else if (op === '>') redirects.push({ kind: 'out', fd: explicitFd ?? 1, target: expectTarget() });
    else if (op === '>>') redirects.push({ kind: 'append', fd: explicitFd ?? 1, target: expectTarget() });
    else if (op === '<>') redirects.push({ kind: 'rw', fd: explicitFd ?? 0, target: expectTarget() });
    else if (op === '>|') redirects.push({ kind: 'out', fd: explicitFd ?? 1, target: expectTarget() });
    else if (op === '&>') {
      const target = expectTarget();
      redirects.push({ kind: 'out', fd: 1, target });
      redirects.push({ kind: 'dup', fd: 2, targetFd: 1 });
    } else if (op === '&>>') {
      const target = expectTarget();
      redirects.push({ kind: 'append', fd: 1, target });
      redirects.push({ kind: 'dup', fd: 2, targetFd: 1 });
    } else if (op === '<<<') {
      const target = expectTarget();
      redirects.push({ kind: 'herestring', fd: explicitFd ?? 0, herestring: target });
    } else if (op === '>&' || op === '<&') {
      const next = this.peek();
      if (!next || next.kind !== 'word') throw new ParseError(`expected fd target for ${op}`);
      this.i++;
      // Parse the target: number, '-', or a word that will resolve to either
      if (next.word.length === 1 && next.word[0]!.kind === 'lit') {
        const text = next.word[0]!.text!;
        if (text === '-') {
          redirects.push({ kind: 'close', fd: explicitFd ?? (op === '>&' ? 1 : 0) });
          return;
        }
        const num = parseInt(text, 10);
        if (!isNaN(num)) {
          redirects.push({ kind: 'dup', fd: explicitFd ?? (op === '>&' ? 1 : 0), targetFd: num });
          return;
        }
      }
      // Fallback: treat as filename redirect
      redirects.push({ kind: op === '>&' ? 'out' : 'in', fd: explicitFd ?? (op === '>&' ? 1 : 0), target: next.word });
    }
  }

  private parseIf(): IfStatement {
    this.i++; // skip 'if'
    const branches: { condition: AnyCmd; body: AnyCmd }[] = [];
    const firstCondition = this.parseCompoundList();
    this.expectKw('then');
    const firstBody = this.parseCompoundList();
    branches.push({ condition: firstCondition, body: firstBody });
    while (this.peekKw('elif')) {
      this.i++;
      const cond = this.parseCompoundList();
      this.expectKw('then');
      const body = this.parseCompoundList();
      branches.push({ condition: cond, body });
    }
    let elseBlock: AnyCmd | undefined;
    if (this.peekKw('else')) {
      this.i++;
      elseBlock = this.parseCompoundList();
    }
    this.expectKw('fi');
    const node: IfStatement = { kind: 'if', branches, redirects: [] };
    if (elseBlock !== undefined) node.else = elseBlock;
    return node;
  }

  private parseWhile(until: boolean): WhileLoop {
    this.i++; // skip while/until
    const condition = this.parseCompoundList();
    this.expectKw('do');
    const body = this.parseCompoundList();
    this.expectKw('done');
    return { kind: 'while', until, condition, body, redirects: [] };
  }

  private parseFor(): AnyCmd {
    this.i++; // skip 'for'
    // C-style: for ((init; cond; upd)); do ...
    const next = this.peek();
    if (next && next.kind === 'op' && next.op === '(') {
      const nextNext = this.peek(1);
      if (nextNext && nextNext.kind === 'op' && nextNext.op === '(') {
        return this.parseForArith();
      }
    }

    const nameTok = this.peek();
    if (!nameTok || nameTok.kind !== 'word' || nameTok.word.length !== 1 || nameTok.word[0]!.kind !== 'lit') {
      throw new ParseError("expected loop variable after 'for'");
    }
    const variable = nameTok.word[0]!.text!;
    this.i++;
    let words: Word[] = [];
    if (this.peekKw('in')) {
      this.i++;
      while (!this.eof() && !this.isStatementEnd() && !(this.peek()!.kind === 'kw' && (this.peek() as { kw: KeywordKind }).kw === 'do')) {
        const t = this.peek()!;
        if (t.kind === 'word') {
          words.push(t.word);
          this.i++;
          continue;
        }
        break;
      }
    } else {
      // for VAR; do …  — iterate over positional params
      words = [[{ kind: 'var', name: '@' }]];
    }
    // Consume separators
    while (!this.eof()) {
      const t = this.peek()!;
      if (t.kind === 'op' && (t.op === ';' || t.op === '&')) this.i++;
      else if (t.kind === 'newline') this.i++;
      else break;
    }
    this.expectKw('do');
    const body = this.parseCompoundList();
    this.expectKw('done');
    return { kind: 'for', variable, words, body, redirects: [] };
  }

  // C-style arithmetic for-loop: `for (( init ; cond ; step )) ; do ... done`.
  // Strategy: tokens have no source-offset field, so we reconstruct each of the
  // three arithmetic segments by walking the token stream between the outer
  // `((` and `))`, using paren-depth tracking, splitting on `;` op tokens
  // (and on `;;` op tokens, which the tokenizer merges — each counts as two
  // segment boundaries with an empty middle segment).
  private parseForArith(): CForLoop {
    // Positioned at first `(` op. Consume the two `(` tokens.
    const l1 = this.peek();
    if (!l1 || l1.kind !== 'op' || l1.op !== '(') throw new ParseError("expected '((' in C-style for");
    this.i++;
    const l2 = this.peek();
    if (!l2 || l2.kind !== 'op' || l2.op !== '(') throw new ParseError("expected '((' in C-style for");
    this.i++;

    // Collect tokens up to the matching `))` (two `)` op tokens at depth 0).
    const segments: string[][] = [[]];
    let depth = 0;
    while (!this.eof()) {
      const t = this.peek()!;
      if (t.kind === 'op' && t.op === '(') { depth++; segments[segments.length - 1]!.push('('); this.i++; continue; }
      if (t.kind === 'op' && t.op === ')') {
        if (depth === 0) {
          // Need `))`. Consume this `)` and require another one.
          this.i++;
          const t2 = this.peek();
          if (!t2 || t2.kind !== 'op' || t2.op !== ')') throw new ParseError("expected '))' to close C-style for");
          this.i++;
          break;
        }
        depth--; segments[segments.length - 1]!.push(')'); this.i++; continue;
      }
      if (t.kind === 'op' && t.op === ';' && depth === 0) {
        segments.push([]);
        this.i++;
        continue;
      }
      if (t.kind === 'op' && t.op === ';;' && depth === 0) {
        // `;;` at depth 0 means two boundaries with an empty middle segment.
        segments.push([]);
        segments.push([]);
        this.i++;
        continue;
      }
      if (t.kind === 'word') {
        segments[segments.length - 1]!.push(t.raw ?? '');
        this.i++; continue;
      }
      if (t.kind === 'op') {
        segments[segments.length - 1]!.push(t.op);
        this.i++; continue;
      }
      if (t.kind === 'newline') { this.i++; continue; }
      throw new ParseError(`unexpected token inside C-style for header: ${JSON.stringify(t)}`);
    }
    if (segments.length !== 3) {
      throw new ParseError(`C-style for header must have exactly 3 segments separated by ';', got ${segments.length}`);
    }
    const [initSrc, condSrc, stepSrc] = segments.map((parts) => parts.join(' ').trim()) as [string, string, string];
    const init: ArithExpr = initSrc === '' ? { kind: 'num', value: 0 } : parseArith(initSrc);
    // Empty condition == true in bash.
    const condition: ArithExpr = condSrc === '' ? { kind: 'num', value: 1 } : parseArith(condSrc);
    const update: ArithExpr = stepSrc === '' ? { kind: 'num', value: 0 } : parseArith(stepSrc);

    // Consume optional `;`/`&`/newline separators before `do`.
    while (!this.eof()) {
      const t = this.peek()!;
      if (t.kind === 'op' && (t.op === ';' || t.op === '&')) this.i++;
      else if (t.kind === 'newline') this.i++;
      else break;
    }
    this.expectKw('do');
    const body = this.parseCompoundList();
    this.expectKw('done');
    return { kind: 'cfor', init, condition, update, body, redirects: [] };
  }

  private parseCase(): CaseStatement {
    this.i++; // skip 'case'
    const wordTok = this.peek();
    if (!wordTok || wordTok.kind !== 'word') throw new ParseError("expected word after 'case'");
    const word = wordTok.word;
    this.i++;
    this.skipNewlines();
    this.expectKw('in');
    this.skipNewlines();

    const arms: { patterns: Word[]; body: AnyCmd; terminator: ';;' | ';&' | ';;&' }[] = [];

    while (!this.eof() && !this.peekKw('esac')) {
      // Optional leading (
      if (this.peek()?.kind === 'op' && (this.peek() as { op: OpKind }).op === '(') this.i++;
      const patterns: Word[] = [];
      while (true) {
        const t = this.peek();
        if (!t || t.kind !== 'word') throw new ParseError('expected case pattern');
        patterns.push(t.word);
        this.i++;
        const nxt = this.peek();
        if (nxt && nxt.kind === 'op' && (nxt.op as unknown as string) === '|') {
          this.i++;
          continue;
        }
        break;
      }
      const closer = this.peek();
      if (!closer || closer.kind !== 'op' || closer.op !== ')') throw new ParseError('expected ) after case pattern');
      this.i++;
      this.skipNewlines();
      // Body until ;; / ;& / ;;&
      const body = this.parseCompoundList();
      let terminator: ';;' | ';&' | ';;&' = ';;';
      const tt = this.peek();
      if (tt && tt.kind === 'op' && (tt.op === ';;' || tt.op === ';&' || tt.op === ';;&')) {
        terminator = tt.op;
        this.i++;
      }
      arms.push({ patterns, body, terminator });
      this.skipNewlines();
    }
    this.expectKw('esac');
    return { kind: 'case', word, arms, redirects: [] };
  }

  private parseFunction(): FunctionDecl {
    this.i++; // skip 'function'
    const nameTok = this.peek();
    if (!nameTok || nameTok.kind !== 'word' || nameTok.word.length !== 1 || nameTok.word[0]!.kind !== 'lit') {
      throw new ParseError("expected function name");
    }
    const name = nameTok.word[0]!.text!;
    this.i++;
    // optional ()
    if (this.peek()?.kind === 'op' && (this.peek() as { op: OpKind }).op === '(') {
      this.i++;
      if (this.peek()?.kind === 'op' && (this.peek() as { op: OpKind }).op === ')') this.i++;
      else throw new ParseError('expected ) after function name(');
    }
    this.skipNewlines();
    const body = this.parseCommand();
    return { kind: 'func', name, body };
  }

  private parseSubshell(): Subshell {
    this.i++; // skip (
    this.skipNewlines();
    const body = this.parseCompoundList();
    const close = this.peek();
    if (!close || close.kind !== 'op' || close.op !== ')') throw new ParseError('expected ) closing subshell');
    this.i++;
    return { kind: 'subshell', body, redirects: [] };
  }

  private parseBraceGroup(): BraceGroup {
    this.i++; // skip {
    this.skipNewlines();
    const body = this.parseCompoundList();
    const close = this.peek();
    if (!close || close.kind !== 'kw' || (close as { kw: KeywordKind }).kw !== ('}' as KeywordKind)) {
      // The tokenizer emits } as an OP, not a keyword
      if (!close || close.kind !== 'op' || close.op !== '}') throw new ParseError('expected } closing brace group');
    }
    this.i++;
    return { kind: 'group', body, redirects: [] };
  }

  private parseExtendedTest(): DoubleBracket {
    this.i++; // skip [[
    const expr = this.parseDbOr();
    const close = this.peek();
    if (!close || close.kind !== 'kw' || (close.kw as string) !== ']]') {
      throw new ParseError('expected ]] to close [[');
    }
    this.i++;
    return { kind: 'dbracket', expr, redirects: [] };
  }

  // precedence:  ||  <  &&  <  !  <  primary (unary/binary tests, parens)
  private parseDbOr(): BoolExpr {
    let left = this.parseDbAnd();
    while (this.peekDbOp('||')) { this.i++; const right = this.parseDbAnd(); left = { kind: 'bOr', left, right }; }
    return left;
  }
  private parseDbAnd(): BoolExpr {
    let left = this.parseDbNot();
    while (this.peekDbOp('&&')) { this.i++; const right = this.parseDbNot(); left = { kind: 'bAnd', left, right }; }
    return left;
  }
  private parseDbNot(): BoolExpr {
    if (this.peekDbBang()) { this.i++; return { kind: 'bNot', left: this.parseDbNot() }; }
    return this.parseDbPrimary();
  }
  private parseDbPrimary(): BoolExpr {
    if (this.peekDbOp('(')) {
      this.i++;
      const e = this.parseDbOr();
      if (!this.peekDbOp(')')) throw new ParseError('expected ) in [[ ]]');
      this.i++;
      return e;
    }
    // Unary test: -f WORD, -z WORD, etc.
    const tok = this.peek();
    if (tok && tok.kind === 'word' && this.isUnaryTestWord(tok.word)) {
      const op = this.flattenWordLit(tok.word) as BoolOp;
      this.i++;
      const arg = this.expectDbWord();
      return { kind: 'bUnary', op, arg };
    }
    // Binary: WORD OP WORD
    const lhs = this.expectDbWord();
    const opTok = this.peek();
    if (opTok && (opTok.kind === 'op' || opTok.kind === 'word')) {
      const opText = opTok.kind === 'op' ? (opTok.op as unknown as string) : this.flattenWordLit(opTok.word);
      if (opText !== null && this.isBinaryTestOp(opText)) {
        this.i++;
        const rhs = this.expectDbWord();
        return { kind: 'bBinary', op: opText as BoolOp, lhs, rhs };
      }
    }
    // Single word — `[[ word ]]` is true iff word is non-empty after expansion.
    return { kind: 'bWord', word: lhs };
  }

  private peekDbOp(op: string): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.kind === 'op' && (t.op as unknown as string) === op) return true;
    // Some ops can appear as word literals (e.g. after quoting); accept those too.
    if (t.kind === 'word') {
      const s = this.flattenWordLit(t.word);
      return s === op;
    }
    return false;
  }
  private peekDbBang(): boolean {
    const t = this.peek();
    if (!t) return false;
    if (t.kind === 'kw' && (t.kw as string) === '!') return true;
    if (t.kind === 'word') return this.flattenWordLit(t.word) === '!';
    return false;
  }
  private expectDbWord(): Word {
    const t = this.peek();
    if (!t || t.kind !== 'word') throw new ParseError('expected word in [[ ]]');
    this.i++;
    return t.word;
  }
  private flattenWordLit(w: Word): string | null {
    if (w.length !== 1) return null;
    const p = w[0]!;
    if (p.kind !== 'lit') return null;
    return p.text ?? null;
  }
  private isBinaryTestOp(s: string): boolean {
    return ['==', '!=', '=~', '<', '>', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-ef', '-nt', '-ot'].includes(s);
  }
  private isUnaryTestWord(w: Word): boolean {
    const s = this.flattenWordLit(w);
    if (s === null) return false;
    return ['-f','-d','-e','-r','-w','-x','-s','-z','-n','-o','-v'].includes(s);
  }

  private peekKw(kw: KeywordKind | string): boolean {
    const t = this.peek();
    if (!t || t.kind !== 'kw') return false;
    return (t.kw as string) === kw;
  }

  private expectKw(kw: KeywordKind): void {
    const t = this.peek();
    if (!t || t.kind !== 'kw' || (t.kw as string) !== kw) {
      const got = t ? `${t.kind === 'kw' ? t.kw : t.kind === 'word' ? 'word' : 'op'}` : 'eof';
      throw new ParseError(`expected keyword '${kw}', got ${got}`);
    }
    this.i++;
  }
}

export const parse = (tokens: Token[], heredocs: Record<number, { body: string; expand: boolean }>): CompoundList => {
  const p = new Parser(tokens, heredocs);
  return p.parseProgram();
};

// Helpers exposed for testing
export const _Parser = Parser;
