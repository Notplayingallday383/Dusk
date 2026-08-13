// /bin/clang, /bin/clang++, /bin/gcc, /bin/g++, /bin/cc — C/C++ compiler via YoWASP Clang.
//
// These tests load YoWASP Clang (LLVM compiled to WASM) lazily on first use
// and may download assets on first run. Generous timeouts are used.

import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

const decode = (b: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]!);
  return s;
};

test('clang --version does not throw a bash parse error', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const r = await repl.processManager.spawnSync(
    '/bin/dsh', ['-c', 'clang --version'], { cwd: '/' });
  const stderr = decode(r.stderr);
  console.log('STDERR:', stderr);
  console.log('STDOUT:', decode(r.stdout));
  console.log('STATUS:', r.status);
  expect(stderr).not.toMatch(/Parse error/);
  expect(stderr).not.toMatch(/unexpected token/);
  expect(r.status).toBe(0);
  repl.engine.terminate();
}, 180_000);

test('clang compiles a simple C file from dsh', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const script = [
    'echo \'int main() { return 0; }\' > /tmp/hello.c',
    'cat /tmp/hello.c',
    'clang /tmp/hello.c -o /tmp/hello.wasm',
    'echo EXIT:$?',
    'ls /tmp/hello.wasm',
  ].join(' && ');
  const r = await repl.processManager.spawnSync('/bin/dsh', ['-c', script], { cwd: '/' });
  const stderr = decode(r.stderr);
  console.log('STDERR:', stderr);
  console.log('STDOUT:', decode(r.stdout));
  console.log('STATUS:', r.status);
  expect(stderr).not.toMatch(/Parse error/);
  expect(decode(r.stdout)).toMatch(/hello\.wasm/);
  expect(r.status).toBe(0);
  repl.engine.terminate();
}, 180_000);
