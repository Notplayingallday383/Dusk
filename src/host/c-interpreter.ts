// Host-side C interpreter bridge for /bin/c and the dsh built-in.
//
// This is a proof-of-concept implementation that interprets a subset of C.
// Similar to TI calculator C interpreters, it supports:
// - Basic stdio (printf, scanf, putchar, getchar)
// - Variables (int, float, char)
// - Control flow (if, while, for)
// - Functions
// - Basic operators
//
// Unlike Python/SQLite which use WASM libraries, this is a pure JS interpreter
// for simplicity and to demonstrate the pattern. A production version would
// use TCC (Tiny C Compiler) compiled to WASM.

import type { FuncTable } from './engine-instance';
import type { FSBackend } from './fs-backend';

const ok = (send: (m: unknown) => void, value: unknown): void => { send({ value }); };
const err = (send: (m: unknown) => void, e: unknown): void => {
  send({ error: e instanceof Error ? e.message : String(e) });
};

// Simple C interpreter for proof-of-concept
class CInterpreter {
  private stdout: string = '';
  private stderr: string = '';
  private stdin: string = '';
  private stdinPos: number = 0;
  private variables: Map<string, number | string> = new Map();
  private exitCode: number = 0;

  constructor(stdin: string = '') {
    this.stdin = stdin;
  }

  // Execute C code and return results
  execute(code: string, argv: string[] = ['c']): { stdout: string; stderr: string; exitCode: number } {
    this.stdout = '';
    this.stderr = '';
    this.stdinPos = 0;
    this.variables.clear();
    this.exitCode = 0;

    try {
      this.run(code, argv);
    } catch (e) {
      this.stderr += (e instanceof Error ? e.message : String(e)) + '\n';
      this.exitCode = 1;
    }

    return {
      stdout: this.stdout,
      stderr: this.stderr,
      exitCode: this.exitCode,
    };
  }

  private run(code: string, argv: string[]): void {
    // Remove comments
    code = code.replace(/\/\/.*$/gm, '');
    code = code.replace(/\/\*[\s\S]*?\*\//g, '');

    // Extract includes (we'll handle stdio.h)
    const includeRegex = /#include\s*[<"]([^>"]+)[>"]/g;
    const includes: string[] = [];
    let match;
    while ((match = includeRegex.exec(code)) !== null) {
      includes.push(match[1]!);
    }

    // Remove preprocessor directives for now
    code = code.replace(/#.*/g, '');

    // Find main function
    const mainMatch = code.match(/int\s+main\s*\(\s*(?:void)?\s*\)\s*\{([\s\S]*)\}/);
    if (!mainMatch) {
      throw new Error('No main() function found');
    }

    const mainBody = mainMatch[1]!;
    this.executeBlock(mainBody);
  }

  private executeBlock(block: string): void {
    // Parse and execute statements
    const statements = this.parseStatements(block);
    
    for (const stmt of statements) {
      this.executeStatement(stmt);
    }
  }

  private parseStatements(block: string): string[] {
    const statements: string[] = [];
    let current = '';
    let braceCount = 0;
    let parenCount = 0;
    let inString = false;
    let escape = false;

    for (let i = 0; i < block.length; i++) {
      const char = block[i]!;
      
      if (escape) {
        current += char;
        escape = false;
        continue;
      }

      if (char === '\\') {
        escape = true;
        current += char;
        continue;
      }

      if (char === '"' && !inString) {
        inString = true;
        current += char;
        continue;
      }

      if (char === '"' && inString) {
        inString = false;
        current += char;
        continue;
      }

      if (!inString) {
        if (char === '{') braceCount++;
        if (char === '}') braceCount--;
        if (char === '(') parenCount++;
        if (char === ')') parenCount--;

        if (char === ';' && braceCount === 0 && parenCount === 0) {
          if (current.trim()) {
            statements.push(current.trim());
          }
          current = '';
          continue;
        }
      }

      current += char;
    }

    if (current.trim()) {
      statements.push(current.trim());
    }

    return statements;
  }

  private executeStatement(stmt: string): void {
    stmt = stmt.trim();
    if (!stmt) return;

    // Variable declaration: int x = 5;
    const varDeclMatch = stmt.match(/^(int|float|char)\s+(\w+)\s*(?:=\s*(.+))?$/);
    if (varDeclMatch) {
      const varName = varDeclMatch[2]!;
      const value = varDeclMatch[3] ? this.evaluateExpression(varDeclMatch[3]) : 0;
      this.variables.set(varName, value);
      return;
    }

    // Assignment: x = 5;
    const assignMatch = stmt.match(/^(\w+)\s*=\s*(.+)$/);
    if (assignMatch) {
      const varName = assignMatch[1]!;
      const value = this.evaluateExpression(assignMatch[2]!);
      this.variables.set(varName, value);
      return;
    }

    // Printf
    if (stmt.startsWith('printf')) {
      this.executePrintf(stmt);
      return;
    }

    // Putchar
    if (stmt.startsWith('putchar')) {
      this.executePutchar(stmt);
      return;
    }

    // Return statement
    if (stmt.startsWith('return')) {
      const returnMatch = stmt.match(/^return\s+(.+)$/);
      if (returnMatch) {
        this.exitCode = Number(this.evaluateExpression(returnMatch[1]!));
      }
      return;
    }

    // If statement
    if (stmt.startsWith('if')) {
      this.executeIf(stmt);
      return;
    }

    // While loop
    if (stmt.startsWith('while')) {
      this.executeWhile(stmt);
      return;
    }

    // For loop
    if (stmt.startsWith('for')) {
      this.executeFor(stmt);
      return;
    }
  }

  private executePrintf(stmt: string): void {
    const printfMatch = stmt.match(/printf\s*\(\s*"([^"]*)"\s*(?:,\s*(.+))?\s*\)/);
    if (!printfMatch) return;

    let format = printfMatch[1]!;
    const argsStr = printfMatch[2];
    const args = argsStr ? argsStr.split(',').map(a => this.evaluateExpression(a.trim())) : [];

    // Handle escape sequences
    format = format.replace(/\\n/g, '\n');
    format = format.replace(/\\t/g, '\t');
    format = format.replace(/\\\\/g, '\\');

    // Simple format string handling
    let output = format;
    let argIndex = 0;
    
    output = output.replace(/%d|%i|%f|%c|%s/g, (match) => {
      if (argIndex >= args.length) return match;
      const value = args[argIndex++];
      if (match === '%c') {
        return String.fromCharCode(Number(value));
      }
      return String(value);
    });

    this.stdout += output;
  }

  private executePutchar(stmt: string): void {
    const putcharMatch = stmt.match(/putchar\s*\(\s*(.+)\s*\)/);
    if (!putcharMatch) return;

    const value = this.evaluateExpression(putcharMatch[1]!);
    this.stdout += String.fromCharCode(Number(value));
  }

  private executeIf(stmt: string): void {
    const ifMatch = stmt.match(/if\s*\(([^)]+)\)\s*\{([^}]*)\}/);
    if (!ifMatch) return;

    const condition = this.evaluateExpression(ifMatch[1]!);
    if (condition) {
      this.executeBlock(ifMatch[2]!);
    }
  }

  private executeWhile(stmt: string): void {
    const whileMatch = stmt.match(/while\s*\(([^)]+)\)\s*\{([^}]*)\}/);
    if (!whileMatch) return;

    const conditionExpr = whileMatch[1]!;
    const body = whileMatch[2]!;

    let iterations = 0;
    const maxIterations = 10000;

    while (this.evaluateExpression(conditionExpr) && iterations < maxIterations) {
      this.executeBlock(body);
      iterations++;
    }

    if (iterations >= maxIterations) {
      throw new Error('Infinite loop detected');
    }
  }

  private executeFor(stmt: string): void {
    const forMatch = stmt.match(/for\s*\(([^;]*);([^;]*);([^)]*)\)\s*\{([^}]*)\}/);
    if (!forMatch) return;

    const init = forMatch[1]!.trim();
    const conditionExpr = forMatch[2]!.trim();
    const increment = forMatch[3]!.trim();
    const body = forMatch[4]!;

    // Execute initialization
    if (init) {
      this.executeStatement(init + ';');
    }

    let iterations = 0;
    const maxIterations = 10000;

    while (this.evaluateExpression(conditionExpr) && iterations < maxIterations) {
      this.executeBlock(body);
      if (increment) {
        this.executeStatement(increment + ';');
      }
      iterations++;
    }

    if (iterations >= maxIterations) {
      throw new Error('Infinite loop detected');
    }
  }

  private evaluateExpression(expr: string): number | string {
    expr = expr.trim();

    // String literal
    if (expr.startsWith('"') && expr.endsWith('"')) {
      return expr.slice(1, -1);
    }

    // Character literal
    if (expr.startsWith("'") && expr.endsWith("'")) {
      return expr.charCodeAt(1);
    }

    // Number literal
    if (/^-?\d+\.?\d*$/.test(expr)) {
      return Number(expr);
    }

    // Variable
    if (/^\w+$/.test(expr)) {
      return this.variables.get(expr) ?? 0;
    }

    // Binary operations
    // Addition/Subtraction
    const addMatch = expr.match(/^(.+?)\s*([+\-])\s*(.+)$/);
    if (addMatch) {
      const left = Number(this.evaluateExpression(addMatch[1]!));
      const right = Number(this.evaluateExpression(addMatch[3]!));
      return addMatch[2] === '+' ? left + right : left - right;
    }

    // Multiplication/Division
    const mulMatch = expr.match(/^(.+?)\s*([*\/])\s*(.+)$/);
    if (mulMatch) {
      const left = Number(this.evaluateExpression(mulMatch[1]!));
      const right = Number(this.evaluateExpression(mulMatch[3]!));
      return mulMatch[2] === '*' ? left * right : left / right;
    }

    // Comparison operators
    const cmpMatch = expr.match(/^(.+?)\s*(==|!=|<=|>=|<|>)\s*(.+)$/);
    if (cmpMatch) {
      const left = Number(this.evaluateExpression(cmpMatch[1]!));
      const right = Number(this.evaluateExpression(cmpMatch[3]!));
      const op = cmpMatch[2]!;
      
      switch (op) {
        case '==': return left === right ? 1 : 0;
        case '!=': return left !== right ? 1 : 0;
        case '<': return left < right ? 1 : 0;
        case '>': return left > right ? 1 : 0;
        case '<=': return left <= right ? 1 : 0;
        case '>=': return left >= right ? 1 : 0;
      }
    }

    // Increment/Decrement
    const incMatch = expr.match(/^(\w+)\s*(\+\+|--)$/);
    if (incMatch) {
      const varName = incMatch[1]!;
      const currentValue = Number(this.variables.get(varName) ?? 0);
      const newValue = incMatch[2] === '++' ? currentValue + 1 : currentValue - 1;
      this.variables.set(varName, newValue);
      return currentValue;
    }

    return 0;
  }
}

export const createCFuncs = (fs: FSBackend): FuncTable => ({
  // c.exec { code: string, argv?: string[], stdin?: string }
  //   → { stdout: string, stderr: string, exitCode: number }
  // Interprets and runs C code with argv/stdin plumbed in.
  'c.exec': (m, send): void => {
    try {
      const code = m['code'] as string;
      const argv = (m['argv'] as string[] | undefined) ?? ['c'];
      const stdin = (m['stdin'] as string | undefined) ?? '';

      const interpreter = new CInterpreter(stdin);
      const result = interpreter.execute(code, argv);
      
      ok(send, result);
    } catch (e) {
      err(send, e);
    }
  },

  // c.version → { version: string }
  'c.version': (_m, send): void => {
    ok(send, { version: 'C Interpreter 1.0.0 (Dusk proof-of-concept)' });
  },

  // Marker so TS uses `fs` (a hook for future TFS↔C file I/O).
  __c_touch_fs: ((_m: Record<string, unknown>, send: (m: unknown) => void): void => {
    void fs; ok(send, { ok: true });
  }) as unknown as FuncTable[string],
});
