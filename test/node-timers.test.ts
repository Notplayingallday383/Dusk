import { expect, test } from 'vitest';
import { createRunner } from '../src/host/runner';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { ProcessManager } from '../src/host/process-manager';

test('global setTimeout dispatches after its initiating evaluation', async () => {
  const out: string[] = [];
  const runner = await createRunner(createFuncs(createMemoryBackend(), (text) => out.push(text)));

  await runner.run("setTimeout(() => console.log('timer-fired'), 0); console.log('initial');");
  expect(out.join('')).toContain('initial');
  expect(out.join('')).not.toContain('timer-fired');

  const deadline = Date.now() + 5_000;
  while (!out.join('').includes('timer-fired') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  runner.stop();

  expect(out.join('')).toContain('timer-fired');
}, 60_000);

test('clearTimeout suppresses a scheduled callback', async () => {
  const out: string[] = [];
  const runner = await createRunner(createFuncs(createMemoryBackend(), (text) => out.push(text)));

  await runner.run("const timer = setTimeout(() => console.log('should-not-fire'), 0); clearTimeout(timer); console.log('cancelled');");
  const deadline = Date.now() + 200;
  while (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  runner.stop();

  expect(out.join('')).toContain('cancelled');
  expect(out.join('')).not.toContain('should-not-fire');
}, 60_000);

test('clearInterval from its callback prevents rearming', async () => {
  const out: string[] = [];
  const runner = await createRunner(createFuncs(createMemoryBackend(), (text) => out.push(text)));

  await runner.run("let count = 0; const timer = setInterval(() => { count++; console.log('tick-' + count); if (count === 2) clearInterval(timer); }, 0);");
  const deadline = Date.now() + 5_000;
  while (!out.join('').includes('tick-2') && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  runner.stop();

  expect(out.join('')).toContain('tick-1');
  expect(out.join('')).toContain('tick-2');
  expect(out.join('')).not.toContain('tick-3');
}, 60_000);

test('timer handles expose Node ref and numeric-coercion methods', async () => {
  const out: string[] = [];
  const runner = await createRunner(createFuncs(createMemoryBackend(), (text) => out.push(text)));

  await runner.run("const timer = setTimeout(() => {}, 1); console.log(timer.hasRef() + ':' + timer.unref().hasRef() + ':' + timer.ref().hasRef() + ':' + (Number(timer) > 0)); clearTimeout(timer);");
  runner.stop();

  expect(out.join('')).toContain('true:false:true:true');
}, 60_000);

test('a node entry awaits the stable lifecycle retained while main starts', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/node', `
    const procRec = globalThis.__process;
    procRec._exitReserved = true;
    const lifecycle = procRec.__duskLifecycle;
    const release = lifecycle.retain();
    setTimeout(() => { process.stdout.write('timer-fired'); release(); }, 10);
    lifecycle.whenIdle().then(() => process.exit(0));
  `);

  const proc = await pm.spawn('/bin/node', [], { cwd: '/' });
  const reader = proc.stdout.getReader();
  const output = await Promise.race([
    reader.read().then((result) => new TextDecoder().decode(result.value)),
    new Promise<string>((_, reject) => setTimeout(() => reject(new Error('timer did not fire')), 5_000)),
  ]);

  expect(output).toBe('timer-fired');
  await expect(proc.exit).resolves.toBe(0);
}, 60_000);
