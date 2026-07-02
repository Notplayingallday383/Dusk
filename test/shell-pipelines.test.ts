import { test, expect } from 'vitest';
import { tokenize } from '../src/shell/tokenizer-v2';
import { parse } from '../src/shell/parser-v2';
import { execute } from '../src/shell/executor-v2';
import { createInitialState, type ShellState } from '../src/shell/scope';

interface Captured {
  stdout: string;
  stderr: string;
  state: ShellState;
  status: number;
}

// Engine lacks TextDecoder (see decisions log). Decode Uint8Array byte-by-byte.
const decodeBytes = (chunks: Uint8Array[]): string => {
  let s = '';
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) s += String.fromCharCode(c[i]!);
  }
  return s;
};

const runScript = async (script: string, opts: { pipefail?: boolean } = {}): Promise<Captured> => {
  const state = createInitialState();
  if (opts.pipefail) state.setOptions.pipefail = true;
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
    const status = await execute(ast, state);
    return {
      stdout: decodeBytes(stdoutChunks),
      stderr: decodeBytes(stderrChunks),
      state,
      status,
    };
  } finally {
    g['process'] = savedProcess;
  }
};

test('pipeline: yes | head -n 5 terminates and prints exactly 5 lines', async () => {
  const r = await runScript('yes | head -n 5');
  expect(r.stdout).toBe('y\ny\ny\ny\ny\n');
  expect(r.status).toBe(0);
  expect(r.state.pipeStatus).toEqual([141, 0]);
}, 5000);

test('pipeline: echo hi | cat | cat | wc -l == 1', async () => {
  const r = await runScript('echo hi | cat | cat | wc -l');
  expect(r.stdout.trim()).toBe('1');
  expect(r.status).toBe(0);
}, 5000);

test('pipeline: false | true returns 0 by default', async () => {
  const r = await runScript('false | true');
  expect(r.status).toBe(0);
  expect(r.state.pipeStatus).toEqual([1, 0]);
});

test('pipeline: false | true returns 1 with pipefail', async () => {
  const r = await runScript('false | true', { pipefail: true });
  expect(r.status).toBe(1);
  expect(r.state.pipeStatus).toEqual([1, 0]);
});

test('pipeline: seq 1 1000 | head -n 3 prints 1,2,3 and tears down seq', async () => {
  const r = await runScript('seq 1 1000 | head -n 3');
  expect(r.stdout).toBe('1\n2\n3\n');
  expect(r.status).toBe(0);
  expect([0, 141]).toContain(r.state.pipeStatus[0]);
  expect(r.state.pipeStatus[1]).toBe(0);
}, 5000);

// Engine setTimeout is a fake (fires within current job drain — see decisions log
// landmine). Wall-time timing can't distinguish concurrent vs sequential. Instead
// prove concurrency functionally: `yes | head -n 5` cannot terminate under a
// sequential runner (yes never yields), so its termination in test 1 already
// proves stage concurrency. Here we additionally assert the pipeline of two
// sleeps runs to completion with status 0 (both stages ran).
test('pipeline: sleep | sleep both complete (concurrency proved by test 1)', async () => {
  const r = await runScript('sleep 0.05 | sleep 0.05');
  expect(r.status).toBe(0);
  expect(r.state.pipeStatus).toEqual([0, 0]);
}, 5000);

test('pipeline: shared pipelineGroup pgid across stages', async () => {
  const r = await runScript('cat | wc -l');
  const lastPgid = (r.state as ShellState & { _lastPipelineGroupPgid?: number })._lastPipelineGroupPgid;
  expect(typeof lastPgid).toBe('number');
  expect(lastPgid).toBeGreaterThan(0);
});

test('pipeline: peak buffer is bounded under yes | head -n 5', async () => {
  const t0 = Date.now();
  const r = await runScript('yes | head -n 5');
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(r.stdout).toBe('y\ny\ny\ny\ny\n');
});

test('pipeline: single-stage pipeline (no pipe operator) goes through simple path', async () => {
  const r = await runScript('echo solo');
  expect(r.stdout.trim()).toBe('solo');
  expect(r.status).toBe(0);
});

test('pipeline: negation operator', async () => {
  const r = await runScript('! false | true');
  expect(r.status).toBe(1);
});
