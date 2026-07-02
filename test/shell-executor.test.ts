import { test, expect, beforeEach, afterEach } from 'vitest';
import { runShellScript, execute } from '../src/shell/index';
import { tokenize } from '../src/shell/tokenizer';
import { parse } from '../src/shell/parser';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createEngine } from '../src/host/engine-instance';
import type { FuncTable } from '../src/host/engine-instance';

interface FsShim {
  readFile(path: string): string;
  writeFile(path: string, data: string): void;
  exists(path: string): boolean;
}

interface ProcShim {
  stdout: { write: (d: Uint8Array | string) => void };
  stderr: { write: (d: Uint8Array | string) => void };
  exit: (code: number) => void;
  argv: string[];
  env: Record<string, string>;
  cwd: () => string;
}

let stdoutBuf: number[];
let stderrBuf: number[];
let exitCalls: number[];
let fsStore: Record<string, string>;
let prevProcess: unknown;
let prevFs: unknown;

const decode = (bytes: number[]): string => new TextDecoder().decode(new Uint8Array(bytes));

beforeEach(() => {
  stdoutBuf = [];
  stderrBuf = [];
  exitCalls = [];
  fsStore = {};
  const g = globalThis as Record<string, unknown>;
  prevProcess = g['process'];
  prevFs = g['__fs'];

  const procShim: ProcShim = {
    stdout: {
      write: (d) => {
        if (typeof d === 'string') for (const b of new TextEncoder().encode(d)) stdoutBuf.push(b);
        else for (const b of d) stdoutBuf.push(b);
      },
    },
    stderr: {
      write: (d) => {
        if (typeof d === 'string') for (const b of new TextEncoder().encode(d)) stderrBuf.push(b);
        else for (const b of d) stderrBuf.push(b);
      },
    },
    exit: (code) => { exitCalls.push(code); },
    argv: ['/bin/sh'],
    env: {},
    cwd: () => '/',
  };
  const fsShim: FsShim = {
    readFile: (p) => {
      if (!(p in fsStore)) throw new Error('ENOENT: ' + p);
      return fsStore[p]!;
    },
    writeFile: (p, data) => { fsStore[p] = data; },
    exists: (p) => p in fsStore,
  };
  g['process'] = procShim;
  g['__fs'] = fsShim;
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  if (prevProcess === undefined) delete g['process']; else g['process'] = prevProcess;
  if (prevFs === undefined) delete g['__fs']; else g['__fs'] = prevFs;
});

test('echo builtin writes to stdout and exits 0', () => {
  const code = runShellScript('echo hello');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('hello\n');
});

test('pwd reflects state cwd', () => {
  const code = runShellScript('pwd', { cwd: '/var/tmp' });
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('/var/tmp\n');
});

test('cd updates state cwd', () => {
  const tokens = tokenize('cd /tmp');
  const ast = parse(tokens);
  const state = { cwd: '/', env: {} as Record<string, string>, exitCode: 0, exitRequested: false, exitRequestedCode: 0, positional: ['sh'] };
  execute(ast, state);
  expect(state.cwd).toBe('/tmp');
});

test('true && echo ok prints ok with status 0', () => {
  const code = runShellScript('true && echo ok');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('ok\n');
});

test('false && echo no skips echo, status 1', () => {
  const code = runShellScript('false && echo no');
  expect(code).toBe(1);
  expect(decode(stdoutBuf)).toBe('');
});

test('false || echo yes prints yes with status 0', () => {
  const code = runShellScript('false || echo yes');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('yes\n');
});

test('echo a; echo b runs both, final status 0', () => {
  const code = runShellScript('echo a; echo b');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('a\nb\n');
});

test('exit 7 returns 7 from runShellScript', () => {
  const code = runShellScript('exit 7');
  expect(code).toBe(7);
});

test('redirect > writes to fs and produces no stdout', () => {
  const code = runShellScript('echo hi > /tmp/out');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('');
  expect(fsStore['/tmp/out']).toBe('hi\n');
});

test('redirect >> appends to fs', () => {
  fsStore['/tmp/log'] = 'first\n';
  const code = runShellScript('echo second >> /tmp/log');
  expect(code).toBe(0);
  expect(fsStore['/tmp/log']).toBe('first\nsecond\n');
});

test('variable expansion: $FOO from state env', () => {
  const code = runShellScript('echo $FOO', { env: { FOO: 'bar' } });
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('bar\n');
});

test('tokenize error surfaces as exit 2 with sh: on stderr', () => {
  const code = runShellScript("echo 'unterminated");
  expect(code).toBe(2);
  expect(decode(stderrBuf)).toContain('sh:');
});

test('parse error surfaces as exit 2 with sh: on stderr', () => {
  const code = runShellScript('echo > ');
  expect(code).toBe(2);
  expect(decode(stderrBuf)).toContain('sh:');
});

test('/bin/sh -c echo hello via ProcessManager', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo hello'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 60_000);

test('/bin/sh -c exit 3 propagates exit code', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'exit 3'], { cwd: '/' });
  expect(result.status).toBe(3);
}, 60_000);

test('/bin/sh -c dispatches to /bin/echo external binary', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);
  await engine.run(`
const cp = require('child_process');
const r = cp.spawnSync('/bin/sh', ['-c', '/bin/echo hi']);
process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));
`);
  await engine.terminate();
  expect(captured).toContain('status=0');
  expect(captured).toContain('hi');
}, 120_000);

test('/bin/sh -c true && /bin/echo ok runs second command', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);
  await engine.run(`
const cp = require('child_process');
const r = cp.spawnSync('/bin/sh', ['-c', 'true && /bin/echo ok']);
process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));
`);
  await engine.terminate();
  expect(captured).toContain('status=0');
  expect(captured).toContain('ok');
}, 120_000);

test('/bin/pwd prints cwd option', async () => {
  const backend = createMemoryBackend();
  await backend.mkdir('/var/work', { recursive: true });
  const pm = new ProcessManager(backend);
  const result = await pm.spawnSync('/bin/pwd', [], { cwd: '/var/work' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('/var/work\n');
}, 60_000);

test('cd /tmp/.. normalizes to /', () => {
  const tokens = tokenize('cd /tmp/..');
  const ast = parse(tokens);
  const state = { cwd: '/', env: {} as Record<string, string>, exitCode: 0, exitRequested: false, exitRequestedCode: 0, positional: ['sh'] };
  execute(ast, state);
  expect(state.cwd).toBe('/');
});

test('cd ./sub then cd .. normalizes correctly', () => {
  const state = { cwd: '/tmp', env: {} as Record<string, string>, exitCode: 0, exitRequested: false, exitRequestedCode: 0, positional: ['sh'] };
  execute(parse(tokenize('cd ./sub')), state);
  expect(state.cwd).toBe('/tmp/sub');
  execute(parse(tokenize('cd ..')), state);
  expect(state.cwd).toBe('/tmp');
});

test('export FOO=bar then echo $FOO prints bar', () => {
  const code = runShellScript('export FOO=bar; echo $FOO');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('bar\n');
});

test('echo $? reflects exit code of previous command (false -> 1)', () => {
  const code = runShellScript('false; echo $?');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('1\n');
});

test('echo $? reflects exit code of previous command (true -> 0)', () => {
  const code = runShellScript('true; echo $?');
  expect(code).toBe(0);
  expect(decode(stdoutBuf)).toBe('0\n');
});

test('/bin/sh -c echo $1 x y prints y', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo $1', 'x', 'y'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('y\n');
}, 60_000);

test('/bin/sh -c echo $# a b c prints 2', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo $#', 'a', 'b', 'c'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('2\n');
}, 60_000);

test('/bin/false via ProcessManager exits 1', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/false', [], { cwd: '/' });
  expect(result.status).toBe(1);
}, 60_000);

test('/bin/env via ProcessManager prints env entries', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/env', [], { cwd: '/', env: { FOO: 'bar' } });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toContain('FOO=bar\n');
}, 60_000);

test('/bin/cat via ProcessManager with no stdin exits cleanly', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/cat', [], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('');
}, 60_000);

test('/bin/cat via ProcessManager with stdin echoes input', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/cat', [], { cwd: '/', stdin: new TextEncoder().encode('hello\n') });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 60_000);

test('/bin/sh -c echo hi | /bin/cat pipes stdin to external cat', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const result = await pm.spawnSync('/bin/sh', ['-c', 'echo hello | /bin/cat'], { cwd: '/' });
  expect(result.status).toBe(0);
  expect(new TextDecoder().decode(result.stdout)).toBe('hello\n');
}, 120_000);

test.todo('pipeline streaming (v2): yes | head terminates without hang');

test('/bin/cat via ProcessManager handles large (32KB) stdin payload', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  const size = 32 * 1024;
  const input = new Uint8Array(size);
  for (let i = 0; i < size; i++) input[i] = (i * 31 + 7) & 0xff;
  const result = await pm.spawnSync('/bin/cat', [], { cwd: '/', stdin: input });
  expect(result.status).toBe(0);
  expect(result.stdout.length).toBe(size);
  for (let i = 0; i < size; i++) expect(result.stdout[i]).toBe(input[i]);
}, 120_000);
