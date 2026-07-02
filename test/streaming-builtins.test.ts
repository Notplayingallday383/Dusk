import { test, expect } from 'vitest';
import { streamingBuiltins } from '../src/shell/streaming-builtins';
import { createPipeChannel } from '../src/shell/pipe-channel';
import { createInitialState } from '../src/shell/scope';

// NOTE: engine has no TextDecoder (see decisions log). Use String.fromCharCode.
const decode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

test('streaming-builtin: true returns 0', async () => {
  const state = createInitialState();
  const out = createPipeChannel(4);
  const stdin = createPipeChannel(4);
  stdin.close();
  const status = await streamingBuiltins['true']!(
    [], state, { stdinStream: stdin.readable, writeStdout: out.write, writeStderr: out.write, signalEof: out.close },
  );
  out.close();
  expect(status).toBe(0);
});

test('streaming-builtin: false returns 1', async () => {
  const state = createInitialState();
  const out = createPipeChannel(4);
  const stdin = createPipeChannel(4);
  stdin.close();
  const status = await streamingBuiltins['false']!(
    [], state, { stdinStream: stdin.readable, writeStdout: out.write, writeStderr: out.write, signalEof: out.close },
  );
  out.close();
  expect(status).toBe(1);
});

test('streaming-builtin: yes emits y\\n forever until EPIPE then returns 141', async () => {
  const state = createInitialState();
  const out = createPipeChannel(2);
  const stdin = createPipeChannel(4);
  stdin.close();
  const runP = streamingBuiltins['yes']!(
    [], state, { stdinStream: stdin.readable, writeStdout: out.write, writeStderr: out.write, signalEof: out.close },
  );
  // drain 3 chunks then close reader to break the pipe
  const it = out.readable[Symbol.asyncIterator]();
  for (let i = 0; i < 3; i++) {
    const { value } = await it.next();
    expect(decode(value as Uint8Array)).toBe('y\n');
  }
  out.closeReader();
  expect(await runP).toBe(141);
});

test('streaming-builtin: yes with custom arg emits arg+\\n', async () => {
  const state = createInitialState();
  const out = createPipeChannel(2);
  const stdin = createPipeChannel(4);
  stdin.close();
  const runP = streamingBuiltins['yes']!(
    ['hi'], state, { stdinStream: stdin.readable, writeStdout: out.write, writeStderr: out.write, signalEof: out.close },
  );
  const it = out.readable[Symbol.asyncIterator]();
  const { value } = await it.next();
  expect(decode(value as Uint8Array)).toBe('hi\n');
  out.closeReader();
  await runP;
});

// NOTE: engine setTimeout is fake (see decisions log: no real delay). Sleep
// returns immediately with status 0 rather than blocking. This preserves the
// exit-code contract (which is what pipelines care about) while accepting the
// timing divergence documented in the landmines file.
test('streaming-builtin: sleep exits 0 for valid non-negative arg', async () => {
  const state = createInitialState();
  const out = createPipeChannel(4);
  const stdin = createPipeChannel(4);
  stdin.close();
  const status = await streamingBuiltins['sleep']!(
    ['0.1'], state, { stdinStream: stdin.readable, writeStdout: out.write, writeStderr: out.write, signalEof: out.close },
  );
  expect(status).toBe(0);
});

test('streaming-builtin: sleep exits 1 for invalid arg', async () => {
  const state = createInitialState();
  const out = createPipeChannel(4);
  const stdin = createPipeChannel(4);
  stdin.close();
  const status = await streamingBuiltins['sleep']!(
    ['abc'], state, { stdinStream: stdin.readable, writeStdout: out.write, writeStderr: out.write, signalEof: out.close },
  );
  expect(status).toBe(1);
});

// NOTE: engine has no TextEncoder either (see decisions log). Hand-roll.
const encodeStr = (s: string): Uint8Array => {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
  return b;
};

const runBuiltin = async (
  name: keyof typeof streamingBuiltins,
  args: string[],
  stdinText: string,
): Promise<{ status: number; out: string }> => {
  const state = createInitialState();
  const stdin = createPipeChannel(8);
  const stdout = createPipeChannel(8);
  if (stdinText.length > 0) await stdin.write(encodeStr(stdinText));
  stdin.close();
  let outText = '';
  const drain = (async () => {
    for await (const c of stdout.readable) outText += decode(c);
  })();
  const status = await streamingBuiltins[name]!(args, state, {
    stdinStream: stdin.readable,
    writeStdout: stdout.write,
    writeStderr: stdout.write,
    signalEof: stdout.close,
  });
  stdout.close();
  await drain;
  return { status, out: outText };
};

test('streaming-builtin: cat copies stdin to stdout', async () => {
  const r = await runBuiltin('cat', [], 'abc\ndef\n');
  expect(r.status).toBe(0);
  expect(r.out).toBe('abc\ndef\n');
});

test('streaming-builtin: head -n 5 returns first 5 lines and stops', async () => {
  const input = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n') + '\n';
  const r = await runBuiltin('head', ['-n', '5'], input);
  expect(r.status).toBe(0);
  expect(r.out).toBe('line0\nline1\nline2\nline3\nline4\n');
});

test('streaming-builtin: head -c 16 returns first 16 bytes', async () => {
  const r = await runBuiltin('head', ['-c', '16'], 'abcdefghijklmnopqrstuvwxyz');
  expect(r.status).toBe(0);
  expect(r.out).toBe('abcdefghijklmnop');
});

test('streaming-builtin: wc -l counts lines', async () => {
  const r = await runBuiltin('wc', ['-l'], 'a\nb\nc\n');
  expect(r.status).toBe(0);
  expect(r.out.trim()).toBe('3');
});

test('streaming-builtin: wc -c counts bytes', async () => {
  const r = await runBuiltin('wc', ['-c'], 'hello');
  expect(r.status).toBe(0);
  expect(r.out.trim()).toBe('5');
});

test('streaming-builtin: tr a-z A-Z uppercases', async () => {
  const r = await runBuiltin('tr', ['a-z', 'A-Z'], 'Hello World\n');
  expect(r.status).toBe(0);
  expect(r.out).toBe('HELLO WORLD\n');
});

test('streaming-builtin: seq 1 5 emits 1..5', async () => {
  const r = await runBuiltin('seq', ['1', '5'], '');
  expect(r.status).toBe(0);
  expect(r.out).toBe('1\n2\n3\n4\n5\n');
});

test('streaming-builtin: seq 1 1 1000 emits all 1000 lines', async () => {
  const r = await runBuiltin('seq', ['1', '1', '1000'], '');
  expect(r.status).toBe(0);
  expect(r.out.split('\n').filter(Boolean).length).toBe(1000);
});

import { builtins, isBuiltin } from '../src/shell/builtins-v2';

test('buffer-mode adapter: head -n 2 via builtins map', async () => {
  expect(isBuiltin('head')).toBe(true);
  expect(isBuiltin('cat')).toBe(true);
  expect(isBuiltin('wc')).toBe(true);
  expect(isBuiltin('tr')).toBe(true);
  expect(isBuiltin('seq')).toBe(true);
  expect(isBuiltin('yes')).toBe(true);
  expect(isBuiltin('sleep')).toBe(true);
  const state = createInitialState();
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  const status = await builtins['head']!(
    ['-n', '2'], state,
    { stdin: encodeStr('a\nb\nc\nd\n'), stdout, stderr },
  );
  expect(status).toBe(0);
  let s = '';
  for (const c of stdout) s += decode(c);
  expect(s).toBe('a\nb\n');
});
