import { describe, it, expect } from 'vitest';
import { tokenize } from '../src/shell/tokenizer-v2';
import { parse } from '../src/shell/parser-v2';
import { execute } from '../src/shell/executor-v2';
import { createInitialState, type ShellState } from '../src/shell/scope';

interface Captured {
  stdout: string;
  stderr: string;
  state: ShellState;
  code: number;
}

// Engine lacks TextDecoder (see decisions log). Decode byte-by-byte.
const decodeBytes = (chunks: Uint8Array[]): string => {
  let s = '';
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) s += String.fromCharCode(c[i]!);
  }
  return s;
};

const runScript = async (script: string): Promise<Captured> => {
  const state = createInitialState();
  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];
  const g = globalThis as Record<string, unknown>;
  const savedProcess = g['process'];
  g['process'] = {
    stdout: { write: (d: Uint8Array) => { stdoutChunks.push(d); } },
    stderr: { write: (d: Uint8Array) => { stderrChunks.push(d); } },
  };
  try {
    const { tokens, heredocs } = tokenize(script);
    const ast = parse(tokens, heredocs);
    const code = await execute(ast, state);
    return {
      stdout: decodeBytes(stdoutChunks),
      stderr: decodeBytes(stderrChunks),
      state,
      code,
    };
  } finally {
    g['process'] = savedProcess;
  }
};

describe('shell-v2 C-style for', () => {
  it('counts 0..2', async () => {
    const r = await runScript('for ((i=0; i<3; i++)); do echo $i; done');
    expect(r.code).toBe(0);
    expect(r.stdout).toBe('0\n1\n2\n');
  });

  it('counts down with i-=2', async () => {
    const r = await runScript('for ((i=10; i>5; i-=2)); do echo $i; done');
    expect(r.stdout).toBe('10\n8\n6\n');
  });

  it('empty init uses preset var', async () => {
    const r = await runScript('i=0; for ((;i<3;i++)); do echo hi; done');
    expect(r.stdout).toBe('hi\nhi\nhi\n');
  });

  it('empty cond is truthy (use break to escape)', async () => {
    const r = await runScript('for ((i=0;;i++)); do echo $i; [ $i -ge 1 ] && break; done');
    expect(r.stdout).toBe('0\n1\n');
  });

  it('exit status of empty body is 0', async () => {
    const r = await runScript('for ((i=0;i<3;i++)); do :; done');
    expect(r.code).toBe(0);
  });

  it('break exits the loop', async () => {
    const r = await runScript('for ((i=0;i<10;i++)); do echo $i; [ $i -eq 1 ] && break; done');
    expect(r.stdout).toBe('0\n1\n');
  });

  it('continue skips to step', async () => {
    const r = await runScript('for ((i=0;i<4;i++)); do [ $((i%2)) -eq 0 ] && continue; echo $i; done');
    expect(r.stdout).toBe('1\n3\n');
  });
});

describe('shell-v2 [[ ]] extended test', () => {
  it('returns 0 on equal strings', async () => {
    const r = await runScript('[[ a == a ]]');
    expect(r.code).toBe(0);
  });
  it('returns 1 on unequal strings', async () => {
    const r = await runScript('[[ a == b ]]');
    expect(r.code).toBe(1);
  });

  it('-f on existing file', async () => {
    // Inject a minimal in-memory __fs so `-f` can stat.
    const g = globalThis as Record<string, unknown>;
    const savedFs = g['__fs'];
    const store: Record<string, string> = { '/etc/hostname': 'h\n' };
    g['__fs'] = {
      readFile: (p: string) => { if (!(p in store)) throw new Error('ENOENT'); return store[p]!; },
      writeFile: (p: string, d: string) => { store[p] = d; },
      exists: (p: string) => p in store,
      stat: (p: string) => (p in store ? { isFile: true, isDirectory: false } : (() => { throw new Error('ENOENT'); })()),
    };
    try {
      const r = await runScript('[[ -f /etc/hostname ]] && echo y');
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('y\n');
    } finally {
      if (savedFs === undefined) delete g['__fs']; else g['__fs'] = savedFs;
    }
  });

  it('== does pattern matching', async () => {
    const r = await runScript('[[ abc == a* ]]');
    expect(r.code).toBe(0);
  });

  it('=~ regex with BASH_REMATCH', async () => {
    // TODO bash arrays — expander lacks `${VAR[N]}` subscript parsing; use
    // scalar fallback BASH_REMATCH_0 set by dbracket.ts.
    const r = await runScript('x=42; [[ "$x" =~ ^[0-9]+$ ]] && echo "$BASH_REMATCH_0"');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('42');
  });

  it('|| short-circuits', async () => {
    const r = await runScript('x=y; [[ -z "$x" || "$x" == y ]]');
    expect(r.code).toBe(0);
  });

  it('! negates', async () => {
    const r = await runScript('[[ ! -z "x" ]]');
    expect(r.code).toBe(0);
  });

  it('< is lex compare', async () => {
    // JS string compare: "10" < "3" is true, so "3" < "10" is false → code=1.
    // Matches bash's default C-locale ASCII comparison.
    const r = await runScript('[[ 3 < 10 ]]');
    expect(r.code).toBe(1);
  });
});
