import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// /bin/sh spawned with no args should enter interactive REPL mode:
// print '$ ' prompt, read lines from stdin, execute each, loop.
// Previously it exited immediately with code 0 (empty main).

test('/bin/sh spawned with no args prints prompt and executes lines from stdin', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const sh = await repl.processManager.spawn('/bin/sh', [], {
    cwd: '/',
    env: { PATH: '/bin' },
  });

  const decoder = new TextDecoder();
  let collected = '';
  const pump = async (): Promise<void> => {
    const reader = sh.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) collected += decoder.decode(value, { stream: true });
      }
    } catch { /* */ }
  };
  void pump();

  // Wait for initial prompt.
  const waitFor = async (marker: string, deadlineMs = 8_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (collected.indexOf(marker) === -1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return collected.indexOf(marker) !== -1;
  };

  expect(await waitFor('$ ')).toBe(true);

  // Feed a command.
  const encoder = new TextEncoder();
  await sh.stdin.write(encoder.encode('echo hello-shell\n'));

  // Wait for the echo output.
  expect(await waitFor('hello-shell')).toBe(true);

  // Close stdin — shell should exit on EOF.
  await sh.stdin.close();
  const code = await sh.exit;
  expect(code).toBe(0);

  repl.engine.terminate();
}, 60_000);

test('/bin/sh interactive mode: cd persists across commands', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  const sh = await repl.processManager.spawn('/bin/sh', [], {
    cwd: '/',
    env: { PATH: '/bin' },
  });

  const decoder = new TextDecoder();
  let collected = '';
  const pump = async (): Promise<void> => {
    const reader = sh.stdout.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.length) collected += decoder.decode(value, { stream: true });
      }
    } catch { /* */ }
  };
  void pump();

  const waitFor = async (marker: string, deadlineMs = 8_000): Promise<boolean> => {
    const deadline = Date.now() + deadlineMs;
    while (collected.indexOf(marker) === -1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    return collected.indexOf(marker) !== -1;
  };

  await waitFor('$ ');
  const encoder = new TextEncoder();
  await sh.stdin.write(encoder.encode('cd /tmp\n'));
  await sh.stdin.write(encoder.encode('pwd\n'));

  expect(await waitFor('/tmp')).toBe(true);

  await sh.stdin.close();
  await sh.exit;
  repl.engine.terminate();
}, 60_000);
