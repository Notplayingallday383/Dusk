// Shell v2 tokenizer.
// Produces a token stream where WORD tokens carry structured WordPart[]
// arrays (with embedded var/cmdsub/arith parts), and operators/keywords
// are recognized contextually.

import { parseArith } from './arith';
import type { ArithExpr, ParamOp, Word, WordPart } from './ast';

export type OpKind =
  | '|' | '||' | '&' | '&&' | ';' | ';;' | ';&' | ';;&'
  | '(' | ')' | '{' | '}' | '\n'
  | '<' | '<<' | '<<-' | '<<<' | '>' | '>>' | '<>' | '>|'
  | '>&' | '<&' | '&>' | '&>>' | '|&';

export type KeywordKind =
  | 'if' | 'then' | 'elif' | 'else' | 'fi'
  | 'case' | 'esac' | 'in'
  | 'for' | 'while' | 'until' | 'do' | 'done'
  | 'function' | 'select' | 'time' | '!' | '[[' | ']]'
  | '{' | '}';

export interface WordToken {
  kind: 'word';
  word: Word;
  hasAssignmentPrefix: boolean;  // matches /^[A-Za-z_][A-Za-z0-9_]*\+?=/
  raw: string;
}

export interface OpToken {
  kind: 'op';
  op: OpKind;
}

export interface KeywordToken {
  kind: 'kw';
  kw: KeywordKind;
}

export interface NewlineToken {
  kind: 'newline';
}

export interface HeredocStartToken {
  kind: 'heredoc';
  delim: string;
  stripTabs: boolean;
  expand: boolean;       // false for <<'EOF' / <<"EOF"
  fd: number;            // default 0 (stdin); N<<EOF means fd N
}

export interface IoNumberToken {
  kind: 'io_number';
  fd: number;            // a leading digit before a redirect operator
}

export type Token = WordToken | OpToken | KeywordToken | NewlineToken | HeredocStartToken | IoNumberToken;

export class TokenizeError extends Error {
  constructor(msg: string, public pos?: number) { super(msg); this.name = 'TokenizeError'; }
}

const KEYWORDS = new Set<string>([
  'if', 'then', 'elif', 'else', 'fi',
  'case', 'esac', 'in',
  'for', 'while', 'until', 'do', 'done',
  'function', 'select', 'time', '!', '[[', ']]',
]);

const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdCont = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => /[0-9]/.test(c);

class Tokenizer {
  private i = 0;
  private out: Token[] = [];
  // Heredoc registry: when we emit a heredoc-start, we record (delim, stripTabs, expand)
  // and at the next newline collect the body lines.
  private pendingHeredocs: { delim: string; stripTabs: boolean; expand: boolean; index: number }[] = [];
  private heredocBodies: Record<number, { body: string; expand: boolean }> = {};

  constructor(private src: string) {}

  get heredocs(): Record<number, { body: string; expand: boolean }> {
    return this.heredocBodies;
  }

  tokenize(): Token[] {
    while (this.i < this.src.length) {
      this.skipWhitespaceAndComments();
      if (this.i >= this.src.length) break;
      const c = this.src[this.i]!;

      if (c === '\n') {
        this.emitNewline();
        continue;
      }

      // Operators (longest first)
      const op = this.tryOperator();
      if (op) {
        this.emitOp(op);
        continue;
      }

      // io_number: a digit followed immediately by a redirect operator
      if (isDigit(c)) {
        const start = this.i;
        let j = this.i;
        while (j < this.src.length && isDigit(this.src[j]!)) j++;
        const next = this.src.slice(j, j + 3);
        if (next.startsWith('<') || next.startsWith('>')) {
          const fdStr = this.src.slice(start, j);
          this.out.push({ kind: 'io_number', fd: parseInt(fdStr, 10) });
          this.i = j;
          continue;
        }
      }

      // Word
      this.readWord();
    }

    return this.out;
  }

  private emitNewline(): void {
    // Resolve any pending heredocs.
    if (this.pendingHeredocs.length > 0) {
      this.i++; // consume the newline
      this.collectHeredocBodies();
      this.out.push({ kind: 'newline' });
      return;
    }
    this.out.push({ kind: 'newline' });
    this.i++;
  }

  private collectHeredocBodies(): void {
    for (const h of this.pendingHeredocs) {
      const lines: string[] = [];
      while (this.i < this.src.length) {
        const lineStart = this.i;
        let lineEnd = this.src.indexOf('\n', this.i);
        if (lineEnd === -1) lineEnd = this.src.length;
        let line = this.src.slice(lineStart, lineEnd);
        let cmpLine = line;
        if (h.stripTabs) {
          cmpLine = cmpLine.replace(/^\t+/, '');
          line = line.replace(/^\t+/, '');
        }
        if (cmpLine === h.delim) {
          this.i = lineEnd + 1;
          break;
        }
        lines.push(line);
        this.i = lineEnd + 1;
      }
      this.heredocBodies[h.index] = { body: lines.join('\n') + (lines.length > 0 ? '\n' : ''), expand: h.expand };
    }
    this.pendingHeredocs = [];
  }

  private skipWhitespaceAndComments(): void {
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === ' ' || c === '\t') { this.i++; continue; }
      if (c === '\\' && this.src[this.i + 1] === '\n') { this.i += 2; continue; }
      if (c === '#') {
        // Comment until end of line
        while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++;
        continue;
      }
      break;
    }
  }

  private tryOperator(): OpKind | null {
    const s = this.src;
    const i = this.i;
    // 3-char ops
    if (s.startsWith(';;&', i)) { this.i += 3; return ';;&'; }
    if (s.startsWith('<<-', i)) { this.i += 3; return '<<-'; }
    if (s.startsWith('<<<', i)) { this.i += 3; return '<<<'; }
    if (s.startsWith('&>>', i)) { this.i += 3; return '&>>'; }
    // 2-char ops
    if (s.startsWith(';;', i)) { this.i += 2; return ';;'; }
    if (s.startsWith(';&', i)) { this.i += 2; return ';&'; }
    if (s.startsWith('||', i)) { this.i += 2; return '||'; }
    if (s.startsWith('&&', i)) { this.i += 2; return '&&'; }
    if (s.startsWith('<<', i)) { this.i += 2; return '<<'; }
    if (s.startsWith('>>', i)) { this.i += 2; return '>>'; }
    if (s.startsWith('<>', i)) { this.i += 2; return '<>'; }
    if (s.startsWith('>|', i)) { this.i += 2; return '>|'; }
    if (s.startsWith('>&', i)) { this.i += 2; return '>&'; }
    if (s.startsWith('<&', i)) { this.i += 2; return '<&'; }
    if (s.startsWith('&>', i)) { this.i += 2; return '&>'; }
    if (s.startsWith('|&', i)) { this.i += 2; return '|&'; }
    // 1-char ops
    const c = s[i]!;
    if (c === '|' || c === '&' || c === ';' || c === '(' || c === ')' || c === '{' || c === '}' || c === '<' || c === '>') {
      this.i++;
      return c as OpKind;
    }
    return null;
  }

  private emitOp(op: OpKind): void {
    if (op === '<<' || op === '<<-') {
      // The next word is the delimiter
      this.skipWhitespaceAndComments();
      const delimRaw = this.readDelimWord();
      let delim = delimRaw;
      let expand = true;
      if (delimRaw.startsWith("'") && delimRaw.endsWith("'")) {
        delim = delimRaw.slice(1, -1);
        expand = false;
      } else if (delimRaw.startsWith('"') && delimRaw.endsWith('"')) {
        delim = delimRaw.slice(1, -1);
        expand = false;
      }
      const stripTabs = op === '<<-';
      const index = this.out.length;
      this.out.push({ kind: 'heredoc', delim, stripTabs, expand, fd: 0 });
      this.pendingHeredocs.push({ delim, stripTabs, expand, index });
      return;
    }
    this.out.push({ kind: 'op', op });
  }

  private readDelimWord(): string {
    let out = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (c === ' ' || c === '\t' || c === '\n' || c === ';' || c === '|' || c === '&') break;
      out += c;
      this.i++;
    }
    return out;
  }

  private readWord(): void {
    const start = this.i;
    const parts: WordPart[] = [];
    let rawLit = '';

    const flushLit = (): void => {
      if (rawLit) {
        parts.push({ kind: 'lit', text: rawLit });
        rawLit = '';
      }
    };

    while (this.i < this.src.length) {
      const c = this.src[this.i]!;

      // Word terminators
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (c === ';' || c === '|' || c === '&' || c === '<' || c === '>' || c === '(' || c === ')') break;

      // Comments don't apply mid-word

      if (c === '\\') {
        const next = this.src[this.i + 1];
        if (next === '\n') {
          this.i += 2;
          continue;
        }
        if (next !== undefined) {
          rawLit += next;
          this.i += 2;
          continue;
        }
        this.i++;
        continue;
      }

      if (c === "'") {
        flushLit();
        const text = this.readSingleQuoted();
        parts.push({ kind: 'sq', text });
        continue;
      }

      if (c === '"') {
        flushLit();
        const dqParts = this.readDoubleQuoted();
        parts.push({ kind: 'dq', parts: dqParts });
        continue;
      }

      if (c === '$') {
        // Check for $'...' (ANSI-C) or $"..." (locale) or $(...) or $((...)) or $VAR or ${...}
        const peek = this.src[this.i + 1];
        if (peek === "'") {
          flushLit();
          this.i += 2;
          const text = this.readAnsiCQuoted();
          parts.push({ kind: 'ansi', text });
          continue;
        }
        if (peek === '"') {
          flushLit();
          this.i += 2;
          const dq = this.readDoubleQuotedRaw();
          parts.push({ kind: 'dq', parts: [{ kind: 'lit', text: dq }] });
          continue;
        }
        if (peek === '(') {
          flushLit();
          if (this.src[this.i + 2] === '(') {
            const arith = this.readArithSubstitution();
            parts.push(arith);
          } else {
            const cmdsub = this.readCommandSubstitution();
            parts.push(cmdsub);
          }
          continue;
        }
        if (peek === '{') {
          flushLit();
          const v = this.readBracedParam();
          parts.push(v);
          continue;
        }
        if (peek !== undefined && (isIdStart(peek) || isDigit(peek) || '?#@*!$-_'.includes(peek))) {
          flushLit();
          const v = this.readSimpleParam();
          parts.push(v);
          continue;
        }
        // Bare $
        rawLit += c;
        this.i++;
        continue;
      }

      if (c === '`') {
        flushLit();
        const cmdsub = this.readBacktickSubstitution();
        parts.push(cmdsub);
        continue;
      }

      if (c === '~' && parts.length === 0 && rawLit === '') {
        // Tilde at word start
        let j = this.i + 1;
        let user = '';
        while (j < this.src.length && /[A-Za-z0-9_.\-]/.test(this.src[j]!)) {
          user += this.src[j]!;
          j++;
        }
        // Tilde only valid if followed by /, end-of-word, or =/: (for assignments)
        const nextCh = this.src[j];
        if (nextCh === undefined || nextCh === '/' || nextCh === ':' || nextCh === '=' || /\s/.test(nextCh) || nextCh === ';' || nextCh === '|' || nextCh === '&' || nextCh === '<' || nextCh === '>' || nextCh === '"' || nextCh === "'") {
          const tilde: WordPart = { kind: 'tilde' };
          if (user) tilde.user = user;
          parts.push(tilde);
          this.i = j;
          continue;
        }
        rawLit += c;
        this.i++;
        continue;
      }

      // Glob meta characters — we leave them as literal text; the expander
      // detects metacharacters in the un-quoted joined string to trigger
      // glob expansion. Marking them here is unnecessary.

      rawLit += c;
      this.i++;
    }

    flushLit();

    if (parts.length === 0 && rawLit === '') {
      // Should not happen unless we hit a terminator immediately
      return;
    }

    const word: Word = parts;
    const raw = this.src.slice(start, this.i);

    // Detect keywords (only if the whole word is a single literal part)
    if (parts.length === 1 && parts[0]!.kind === 'lit') {
      const text = parts[0]!.text!;
      if (KEYWORDS.has(text)) {
        this.out.push({ kind: 'kw', kw: text as KeywordKind });
        return;
      }
    }

    // Detect assignment prefix
    let hasAssign = false;
    if (parts[0]?.kind === 'lit') {
      const t = parts[0]!.text!;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(\+?=)(.*)$/.exec(t);
      if (m) hasAssign = true;
    }

    this.out.push({ kind: 'word', word, hasAssignmentPrefix: hasAssign, raw });
  }

  private readSingleQuoted(): string {
    this.i++; // skip opening '
    let out = '';
    while (this.i < this.src.length && this.src[this.i] !== "'") {
      out += this.src[this.i]!;
      this.i++;
    }
    if (this.i >= this.src.length) throw new TokenizeError('unterminated single quote', this.i);
    this.i++; // skip closing '
    return out;
  }

  private readDoubleQuoted(): WordPart[] {
    this.i++; // skip opening "
    const parts: WordPart[] = [];
    let lit = '';
    const flush = (): void => { if (lit) { parts.push({ kind: 'lit', text: lit }); lit = ''; } };

    while (this.i < this.src.length && this.src[this.i] !== '"') {
      const c = this.src[this.i]!;
      if (c === '\\') {
        const next = this.src[this.i + 1];
        if (next === '$' || next === '`' || next === '"' || next === '\\' || next === '\n') {
          if (next !== '\n') lit += next;
          this.i += 2;
          continue;
        }
        // For other escapes, the backslash is preserved
        lit += c;
        this.i++;
        continue;
      }
      if (c === '$') {
        const peek = this.src[this.i + 1];
        if (peek === '(') {
          flush();
          if (this.src[this.i + 2] === '(') {
            const arith = this.readArithSubstitution();
            parts.push(arith);
          } else {
            const cmdsub = this.readCommandSubstitution();
            parts.push(cmdsub);
          }
          continue;
        }
        if (peek === '{') {
          flush();
          parts.push(this.readBracedParam());
          continue;
        }
        if (peek !== undefined && (isIdStart(peek) || isDigit(peek) || '?#@*!$-_'.includes(peek))) {
          flush();
          parts.push(this.readSimpleParam());
          continue;
        }
        lit += c;
        this.i++;
        continue;
      }
      if (c === '`') {
        flush();
        parts.push(this.readBacktickSubstitution());
        continue;
      }
      lit += c;
      this.i++;
    }
    if (this.i >= this.src.length) throw new TokenizeError('unterminated double quote', this.i);
    this.i++; // skip closing "
    flush();
    return parts;
  }

  private readDoubleQuotedRaw(): string {
    let out = '';
    while (this.i < this.src.length && this.src[this.i] !== '"') {
      out += this.src[this.i]!;
      this.i++;
    }
    if (this.i >= this.src.length) throw new TokenizeError('unterminated $"', this.i);
    this.i++;
    return out;
  }

  private readAnsiCQuoted(): string {
    let out = '';
    while (this.i < this.src.length && this.src[this.i] !== "'") {
      const c = this.src[this.i]!;
      if (c === '\\') {
        const next = this.src[this.i + 1];
        if (next === undefined) { this.i++; continue; }
        switch (next) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case '\\': out += '\\'; break;
          case "'": out += "'"; break;
          case '"': out += '"'; break;
          case '0': out += '\0'; break;
          case 'a': out += '\x07'; break;
          case 'b': out += '\b'; break;
          case 'e': case 'E': out += '\x1b'; break;
          case 'f': out += '\f'; break;
          case 'v': out += '\v'; break;
          case 'x': {
            let hex = '';
            let k = this.i + 2;
            while (k < this.src.length && hex.length < 2 && /[0-9a-fA-F]/.test(this.src[k]!)) {
              hex += this.src[k]!;
              k++;
            }
            if (hex.length > 0) {
              out += String.fromCharCode(parseInt(hex, 16));
              this.i = k - 2;
            } else out += 'x';
            break;
          }
          case 'u': {
            let hex = '';
            let k = this.i + 2;
            while (k < this.src.length && hex.length < 4 && /[0-9a-fA-F]/.test(this.src[k]!)) {
              hex += this.src[k]!;
              k++;
            }
            if (hex.length > 0) {
              out += String.fromCharCode(parseInt(hex, 16));
              this.i = k - 2;
            } else out += 'u';
            break;
          }
          default: out += next; break;
        }
        this.i += 2;
        continue;
      }
      out += c;
      this.i++;
    }
    if (this.i >= this.src.length) throw new TokenizeError("unterminated $'", this.i);
    this.i++;
    return out;
  }

  private readSimpleParam(): WordPart {
    this.i++; // skip $
    const c = this.src[this.i]!;
    if (isDigit(c)) {
      this.i++;
      return { kind: 'var', name: c };
    }
    if ('?#@*!$-_'.includes(c)) {
      this.i++;
      return { kind: 'var', name: c };
    }
    let name = '';
    while (this.i < this.src.length && isIdCont(this.src[this.i]!)) {
      name += this.src[this.i]!;
      this.i++;
    }
    return { kind: 'var', name };
  }

  private readBracedParam(): WordPart {
    this.i += 2; // skip ${
    // Special: ${#VAR} for length
    let lengthOp = false;
    let indirectOp = false;
    if (this.src[this.i] === '#') {
      const after = this.src[this.i + 1];
      if (after !== '}' && after !== undefined) {
        lengthOp = true;
        this.i++;
      }
    } else if (this.src[this.i] === '!') {
      indirectOp = true;
      this.i++;
    }
    let name = '';
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (isIdCont(c)) { name += c; this.i++; continue; }
      if (name === '' && (isDigit(c) || '?#@*!$-_'.includes(c))) {
        name = c;
        this.i++;
        continue;
      }
      break;
    }
    if (this.src[this.i] === '}') {
      this.i++;
      if (lengthOp) return { kind: 'var', name, paramOp: { op: 'length' } };
      if (indirectOp) return { kind: 'var', name, paramOp: { op: 'indirect' } };
      return { kind: 'var', name };
    }
    // Operators follow
    const opChar = this.src[this.i];
    const opChar2 = this.src[this.i + 1];
    const opChar3 = this.src[this.i + 2];

    const paramOp: ParamOp = { op: 'default' };
    // : prefix means treat null and unset alike
    let colon = false;
    if (opChar === ':') {
      colon = true;
      this.i++;
    }
    const op2 = this.src[this.i]!;
    if (op2 === '-') {
      paramOp.op = 'default'; paramOp.colon = colon; this.i++;
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === '=') {
      paramOp.op = 'assign'; paramOp.colon = colon; this.i++;
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === '?') {
      paramOp.op = 'error'; paramOp.colon = colon; this.i++;
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === '+') {
      paramOp.op = 'alt'; paramOp.colon = colon; this.i++;
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === '#') {
      if (opChar3 === '#' || (this.src[this.i + 1] === '#')) {
        this.i += 2;
        paramOp.op = 'prefixLong';
      } else {
        this.i++;
        paramOp.op = 'prefixShort';
      }
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === '%') {
      if (this.src[this.i + 1] === '%') {
        this.i += 2;
        paramOp.op = 'suffixLong';
      } else {
        this.i++;
        paramOp.op = 'suffixShort';
      }
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === '/') {
      const after = this.src[this.i + 1];
      if (after === '/') {
        this.i += 2;
        paramOp.op = 'replaceAll';
      } else if (after === '#') {
        this.i += 2;
        paramOp.op = 'replacePrefix';
      } else if (after === '%') {
        this.i += 2;
        paramOp.op = 'replaceSuffix';
      } else {
        this.i++;
        paramOp.op = 'replaceFirst';
      }
      paramOp.pattern = this.readParamWord('/}', true);
      if (this.src[this.i] === '/') {
        this.i++;
        paramOp.replacement = this.readParamWord('}');
      } else {
        paramOp.replacement = [];
      }
    } else if (op2 === '^') {
      if (this.src[this.i + 1] === '^') { this.i += 2; paramOp.op = 'upperAll'; }
      else { this.i++; paramOp.op = 'upperFirst'; }
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === ',') {
      if (this.src[this.i + 1] === ',') { this.i += 2; paramOp.op = 'lowerAll'; }
      else { this.i++; paramOp.op = 'lowerFirst'; }
      paramOp.pattern = this.readParamWord('}');
    } else if (op2 === ':') {
      // Substring: ${VAR:offset:length}
      this.i++;
      paramOp.op = 'substring';
      const offsetExpr = this.readArithUntil('}:');
      paramOp.offset = parseArith(offsetExpr);
      if (this.src[this.i] === ':') {
        this.i++;
        const lengthExpr = this.readArithUntil('}');
        paramOp.length = parseArith(lengthExpr);
      }
    } else {
      throw new TokenizeError(`unexpected param op '${op2}' in \${${name}...}`, this.i);
    }

    if (this.src[this.i] !== '}') {
      throw new TokenizeError(`expected } closing \${${name}...}`, this.i);
    }
    this.i++;
    return { kind: 'var', name, paramOp };
  }

  // Reads parts inside a ${...} operand until one of the stop characters.
  // Note: we do NOT recursively parse nested ${...} or $(...) here in v1; we
  // treat the pattern as a literal Word. This covers ~all real-world usage.
  private readParamWord(stopChars: string, stopOnFirst = false): Word {
    const parts: WordPart[] = [];
    let lit = '';
    const flush = (): void => { if (lit) { parts.push({ kind: 'lit', text: lit }); lit = ''; } };
    let depth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (depth === 0 && stopChars.includes(c)) {
        if (stopOnFirst) break;
        if (c === '}') break;
        if (c === '/') break;
      }
      if (c === '\\' && this.src[this.i + 1] !== undefined) {
        lit += this.src[this.i + 1];
        this.i += 2;
        continue;
      }
      if (c === '{') depth++;
      if (c === '}') {
        if (depth === 0) break;
        depth--;
      }
      lit += c;
      this.i++;
    }
    flush();
    return parts;
  }

  private readArithUntil(stopChars: string): string {
    let out = '';
    let depth = 0;
    while (this.i < this.src.length) {
      const c = this.src[this.i]!;
      if (depth === 0 && stopChars.includes(c)) break;
      if (c === '(') depth++;
      if (c === ')') depth--;
      out += c;
      this.i++;
    }
    return out;
  }

  private readCommandSubstitution(): WordPart {
    this.i += 2; // skip $(
    let depth = 1;
    let body = '';
    while (this.i < this.src.length && depth > 0) {
      const c = this.src[this.i]!;
      if (c === '(') { depth++; body += c; this.i++; continue; }
      if (c === ')') { depth--; if (depth === 0) { this.i++; break; } body += c; this.i++; continue; }
      if (c === '\\' && this.src[this.i + 1] !== undefined) {
        body += c + this.src[this.i + 1];
        this.i += 2;
        continue;
      }
      if (c === "'") {
        body += c;
        this.i++;
        while (this.i < this.src.length && this.src[this.i] !== "'") {
          body += this.src[this.i]!;
          this.i++;
        }
        if (this.i < this.src.length) {
          body += this.src[this.i]!;
          this.i++;
        }
        continue;
      }
      if (c === '"') {
        body += c;
        this.i++;
        while (this.i < this.src.length && this.src[this.i] !== '"') {
          if (this.src[this.i] === '\\' && this.src[this.i + 1] !== undefined) {
            body += this.src[this.i]! + this.src[this.i + 1]!;
            this.i += 2;
            continue;
          }
          body += this.src[this.i]!;
          this.i++;
        }
        if (this.i < this.src.length) {
          body += this.src[this.i]!;
          this.i++;
        }
        continue;
      }
      body += c;
      this.i++;
    }
    return { kind: 'cmdsub', text: body };
  }

  private readBacktickSubstitution(): WordPart {
    this.i++; // skip opening `
    let body = '';
    while (this.i < this.src.length && this.src[this.i] !== '`') {
      const c = this.src[this.i]!;
      if (c === '\\') {
        const next = this.src[this.i + 1];
        if (next === '`' || next === '\\' || next === '$') {
          body += next;
          this.i += 2;
          continue;
        }
        body += c;
        this.i++;
        continue;
      }
      body += c;
      this.i++;
    }
    if (this.i < this.src.length) this.i++; // skip closing `
    return { kind: 'cmdsub', text: body };
  }

  private readArithSubstitution(): WordPart {
    this.i += 3; // skip $((
    let depth = 1;
    let expr = '';
    while (this.i < this.src.length && depth > 0) {
      const c = this.src[this.i]!;
      if (c === '(') { depth++; expr += c; this.i++; continue; }
      if (c === ')') {
        // $((expr)) — two closing parens
        if (this.src[this.i + 1] === ')' && depth === 1) {
          this.i += 2;
          return { kind: 'arith', arithExpr: parseArith(expr) };
        }
        depth--;
        expr += c;
        this.i++;
        continue;
      }
      expr += c;
      this.i++;
    }
    return { kind: 'arith', arithExpr: parseArith(expr) };
  }
}

export const tokenize = (src: string): { tokens: Token[]; heredocs: Record<number, { body: string; expand: boolean }> } => {
  const t = new Tokenizer(src);
  const tokens = t.tokenize();
  return { tokens, heredocs: t.heredocs };
};

export type ArithExprT = ArithExpr;
