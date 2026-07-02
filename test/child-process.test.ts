import { test, expect } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('in-engine require(child_process).spawnSync runs builtin and returns stdout', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/echo', "const msg = process.argv.slice(1).join(' ') + '\\n'; process.stdout.write(msg);");
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  await engine.run(`
const cp = require('child_process');
const r = cp.spawnSync('/bin/echo', ['hello']);
process.stdout.write('status=' + r.status + ' out=' + String.fromCharCode.apply(null, Array.from(r.stdout)));
`);
  await engine.terminate();
  expect(captured).toContain('status=0');
  expect(captured).toContain('hello');
}, 60_000);

test('in-engine require(child_process).spawn streams stdout via dispatch', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/echo', "const msg = process.argv.slice(1).join(' ') + '\\n'; process.stdout.write(msg);");
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  void engine.run(`
const cp = require('child_process');
const child = cp.spawn('/bin/echo', ['hi-stream']);
const chunks = [];
child.stdout.on('data', (d) => { chunks.push.apply(chunks, Array.from(d)); });
await child.exit.then((code) => {
  process.stdout.write('done code=' + code + ' out=' + String.fromCharCode.apply(null, chunks));
  process.exit(0);
});
`);
  const code = await engine.exited;
  expect(code).toBe(0);
  expect(captured).toContain('done code=0');
  expect(captured).toContain('hi-stream');
}, 120_000);

test('in-engine spawn buffers stdout data until late .on(data) attach', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/echo', "const msg = process.argv.slice(1).join(' ') + '\\n'; process.stdout.write(msg);");
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  void engine.run(`
const cp = require('child_process');
const child = cp.spawn('/bin/echo', ['late-attach']);
await child.exit;
const chunks = [];
child.stdout.on('data', (d) => { chunks.push.apply(chunks, Array.from(d)); });
await new Promise((r) => setTimeout(r, 50));
process.stdout.write('late out=' + String.fromCharCode.apply(null, chunks));
process.exit(0);
`);
  const code = await engine.exited;
  expect(code).toBe(0);
  expect(captured).toContain('late out=late-attach');
}, 120_000);

test('in-engine exec with two-arg (command, callback) form succeeds and yields stdout', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  void engine.run(`
const cp = require('child_process');
cp.exec('echo hi', (err, stdout, stderr) => {
  process.stdout.write('err=' + (err === null || err === undefined ? 'none' : 'set') + ' out=' + stdout);
  process.exit(0);
});
`);
  const code = await engine.exited;
  expect(code).toBe(0);
  expect(captured).toContain('err=none');
  expect(captured).toContain('out=hi\n');
}, 120_000);

test('in-engine exec with three-arg (command, options, callback) form succeeds', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  void engine.run(`
const cp = require('child_process');
cp.exec('echo hi', { env: {} }, (err, stdout, stderr) => {
  process.stdout.write('err=' + (err === null || err === undefined ? 'none' : 'set') + ' out=' + stdout);
  process.exit(0);
});
`);
  const code = await engine.exited;
  expect(code).toBe(0);
  expect(captured).toContain('err=none');
  expect(captured).toContain('out=hi\n');
}, 120_000);

test('in-engine exec reports non-zero exit code via err.code', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  void engine.run(`
const cp = require('child_process');
cp.exec('exit 3', (err, stdout, stderr) => {
  process.stdout.write('hasErr=' + (err ? 'yes' : 'no') + ' code=' + (err && err.code));
  process.exit(0);
});
`);
  const code = await engine.exited;
  expect(code).toBe(0);
  expect(captured).toContain('hasErr=yes');
  expect(captured).toContain('code=3');
}, 120_000);

test('in-engine execSync returns Uint8Array on success and throws on non-zero exit', async () => {
  const pm = new ProcessManager(createMemoryBackend());
  pm.registerBinary('/bin/sh', `
if (process.argv[1] === '-c' && process.argv[2]) {
  try { (0, eval)(process.argv[2]); } catch (e) { try { process.stderr.write(String(e)); } catch (_) {} process.exit(1); }
}
`);
  let captured = '';
  const write = (text: string) => { captured += text; };
  const engine = await pm.createPidZero({}, write);

  await engine.run(`
const cp = require('child_process');
const out = cp.execSync('process.stdout.write(\"hi-exec\")');
process.stdout.write('ok type=' + (out && out.constructor && out.constructor.name) + ' len=' + out.length + ' bytes=' + String.fromCharCode.apply(null, Array.from(out)));
let threw = false;
let status = null;
try {
  cp.execSync('process.exit(7)');
} catch (e) {
  threw = true;
  status = e.status;
}
process.stdout.write(' threw=' + threw + ' status=' + status);
`);
  await engine.terminate();
  expect(captured).toContain('ok type=Uint8Array');
  expect(captured).toContain('bytes=hi-exec');
  expect(captured).toContain('threw=true status=7');
}, 120_000);
