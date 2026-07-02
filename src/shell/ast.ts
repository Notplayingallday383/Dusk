// Shell v2 AST.

export interface WordPart {
  kind: 'lit' | 'sq' | 'dq' | 'ansi' | 'var' | 'cmdsub' | 'arith' | 'tilde' | 'brace' | 'glob';
  // 'lit'  — literal text
  // 'sq'   — single-quoted literal (no expansion)
  // 'dq'   — double-quoted (param/cmd/arith expand, no glob)
  // 'ansi' — $'...' ANSI-C decoded
  // 'var'  — $VAR or ${VAR...}
  // 'cmdsub' — $(cmd) or `cmd`
  // 'arith' — $((expr))
  // 'tilde' — ~ or ~user (only at word start)
  // 'brace' — {a,b,c} or {1..10}
  // 'glob'  — unquoted glob metacharacter literal (passes through to globber)
  text?: string;
  parts?: WordPart[];      // for 'dq': nested parts
  name?: string;           // for 'var'
  paramOp?: ParamOp;       // for 'var'
  ast?: SimpleCommand | Pipeline | CompoundList;  // for 'cmdsub'
  arithExpr?: ArithExpr;   // for 'arith'
  braceItems?: string[];   // for 'brace'
  user?: string;           // for 'tilde'
}

export interface ParamOp {
  op:
    | 'default'        // ${VAR:-default}
    | 'assign'         // ${VAR:=default}
    | 'error'          // ${VAR:?msg}
    | 'alt'            // ${VAR:+alt}
    | 'length'         // ${#VAR}
    | 'prefixShort'    // ${VAR#pat}
    | 'prefixLong'     // ${VAR##pat}
    | 'suffixShort'    // ${VAR%pat}
    | 'suffixLong'     // ${VAR%%pat}
    | 'replaceFirst'   // ${VAR/pat/repl}
    | 'replaceAll'     // ${VAR//pat/repl}
    | 'replacePrefix'  // ${VAR/#pat/repl}
    | 'replaceSuffix'  // ${VAR/%pat/repl}
    | 'substring'      // ${VAR:offset:length}
    | 'indirect'       // ${!VAR}
    | 'upperFirst'     // ${VAR^}
    | 'upperAll'       // ${VAR^^}
    | 'lowerFirst'     // ${VAR,}
    | 'lowerAll'       // ${VAR,,}
    ;
  pattern?: Word;
  replacement?: Word;
  offset?: ArithExpr;
  length?: ArithExpr;
  colon?: boolean;     // : preceding operator (default/assign/error/alt distinguish null-and-unset vs unset-only)
}

export type Word = WordPart[];

export interface ArithExpr {
  kind:
    | 'num'
    | 'var'
    | 'unary'
    | 'binary'
    | 'ternary'
    | 'assign'
    | 'preInc'
    | 'preDec'
    | 'postInc'
    | 'postDec';
  value?: number | bigint;
  name?: string;
  op?: string;
  left?: ArithExpr;
  right?: ArithExpr;
  cond?: ArithExpr;
  then?: ArithExpr;
  else?: ArithExpr;
}

export interface Redirect {
  kind: 'in' | 'out' | 'append' | 'rw' | 'heredoc' | 'herestring' | 'dup' | 'close';
  fd: number;
  target?: Word;
  targetFd?: number;     // for 'dup'
  body?: string;         // for 'heredoc': literal body
  expandHeredoc?: boolean; // false for <<'EOF' / <<"EOF"
  herestring?: Word;     // for 'herestring'
  stripTabs?: boolean;   // for <<-EOF
}

export interface Assignment {
  name: string;
  value: Word;
  append: boolean;       // true for `VAR+=val`
}

export interface SimpleCommand {
  kind: 'simple';
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  kind: 'pipeline';
  negated: boolean;
  stages: AnyCmd[];
  // pipefail option respected at execution time
}

export interface ListSequence {
  kind: 'seq';
  items: AnyCmd[];
  ops: (';' | '&' | '\n')[];  // op between items[i] and items[i+1]
}

export interface AndOrList {
  kind: 'andor';
  left: AnyCmd;
  op: '&&' | '||';
  right: AnyCmd;
}

export interface Subshell {
  kind: 'subshell';
  body: AnyCmd;
  redirects: Redirect[];
}

export interface BraceGroup {
  kind: 'group';
  body: AnyCmd;
  redirects: Redirect[];
}

export interface IfStatement {
  kind: 'if';
  branches: { condition: AnyCmd; body: AnyCmd }[];  // first is `if`, rest are `elif`
  else?: AnyCmd;
  redirects: Redirect[];
}

export interface WhileLoop {
  kind: 'while';
  until: boolean;
  condition: AnyCmd;
  body: AnyCmd;
  redirects: Redirect[];
}

export interface ForLoop {
  kind: 'for';
  variable: string;
  words: Word[];
  body: AnyCmd;
  redirects: Redirect[];
}

export interface CForLoop {
  kind: 'cfor';
  init: ArithExpr;
  condition: ArithExpr;
  update: ArithExpr;
  body: AnyCmd;
  redirects: Redirect[];
}

export type BoolOp =
  | 'and' | 'or' | 'not'
  // binary
  | '==' | '!=' | '=~' | '<' | '>'
  | '-eq' | '-ne' | '-lt' | '-le' | '-gt' | '-ge'
  | '-ef' | '-nt' | '-ot'
  // unary
  | '-f' | '-d' | '-e' | '-r' | '-w' | '-x' | '-s'
  | '-z' | '-n' | '-o' | '-v'
  ;

export interface BoolExpr {
  kind: 'bAnd' | 'bOr' | 'bNot' | 'bBinary' | 'bUnary' | 'bWord';
  op?: BoolOp;
  left?: BoolExpr;
  right?: BoolExpr;
  arg?: Word;       // for bUnary
  lhs?: Word;       // for bBinary
  rhs?: Word;       // for bBinary
  word?: Word;      // for bWord (a single word treated as `-n word`)
}

export interface DoubleBracket {
  kind: 'dbracket';
  expr: BoolExpr;
  redirects: Redirect[];
}

export interface CaseStatement {
  kind: 'case';
  word: Word;
  arms: { patterns: Word[]; body: AnyCmd; terminator: ';;' | ';&' | ';;&' }[];
  redirects: Redirect[];
}

export interface FunctionDecl {
  kind: 'func';
  name: string;
  body: AnyCmd;
}

export interface CompoundList {
  kind: 'compound';
  items: AnyCmd[];
}

export type AnyCmd =
  | SimpleCommand
  | Pipeline
  | ListSequence
  | AndOrList
  | Subshell
  | BraceGroup
  | IfStatement
  | WhileLoop
  | ForLoop
  | CForLoop
  | CaseStatement
  | FunctionDecl
  | CompoundList
  | DoubleBracket;
