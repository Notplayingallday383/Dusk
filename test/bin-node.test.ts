import { test, expect } from 'vitest';
import { bootRepl, type RelayListener, type RelaySocket } from '../src/index';

class NodeServerRelaySocket implements RelaySocket {
  sent: Uint8Array[] = [];
  private dataHandlers = new Set<(data: Uint8Array) => void>();

  onData(cb: (data: Uint8Array) => void): () => void {
    this.dataHandlers.add(cb);
    return () => this.dataHandlers.delete(cb);
  }

  onClose(): () => void { return () => {}; }
  send(data: Uint8Array): void { this.sent.push(data.slice()); }
  close(): void {}

  receive(text: string): void {
    const data = new TextEncoder().encode(text);
    for (const cb of [...this.dataHandlers]) cb(data);
  }
}

class NodeServerRelay implements RelayListener {
  handler: ((socket: RelaySocket) => void) | undefined;

  registerListener(_host: string, _port: number, handler: (socket: RelaySocket) => void): () => void {
    this.handler = handler;
    return () => { this.handler = undefined; };
  }
}

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
  if (!predicate()) throw new Error('timed out waiting for condition');
};

test('/bin/node -e prints expression', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['-e', 'process.stdout.write(\"hello-from-node\")']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  expect(text).toContain('OUT=hello-from-node');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node runs a script from VFS', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    seed: { '/tmp/test.js': 'process.stdout.write("from-script");' },
  });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['/tmp/test.js']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  expect(text).toContain('OUT=from-script');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node --version prints node version', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("const cp = require('node:child_process'); const r = cp.spawnSync('/bin/node', ['--version']); process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n')\n");
  await new Promise((r) => setTimeout(r, 700));
  const text = out.join('');
  expect(text).toContain('OUT=v');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node script can require node:fs and read file', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    seed: {
      '/tmp/data.txt': 'hello-data',
      '/tmp/reader.js': "const fs = require('node:fs'); process.stdout.write(fs.readFileSync('/tmp/data.txt', 'utf8'));",
    },
  });
  await repl.feed([
    "const cp = require('node:child_process');",
    "const r = cp.spawnSync('/bin/node', ['/tmp/reader.js']);",
    "process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n');",
    "",
  ].join("\n"));
  await new Promise((r) => setTimeout(r, 1000));
  const text = out.join('');
  expect(text).toContain('OUT=hello-data');
  repl.engine.terminate();
}, 60_000);

test('/bin/node preserves stdout from async main before process.exit', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    seed: {
      '/tmp/async-main.js': [
        "async function main(argv) { process.stdout.write('async-help'); return 0; }",
        "void main(process.argv).then((code) => { if (process.exit) process.exit(code); });",
      ].join('\n'),
    },
  });
  await repl.feed([
    "const cp = require('node:child_process');",
    "const r = cp.spawnSync('/bin/node', ['/tmp/async-main.js']);",
    "process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|STATUS=' + r.status + '\\n');",
    "",
  ].join("\n"));
  await new Promise((r) => setTimeout(r, 1000));
  const text = out.join('');
  expect(text).toContain('OUT=async-help');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node passes --help through to node-style async CLIs', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), {
    fs: 'memory',
    seed: {
      '/tmp/fake-dpm.js': [
        "const main = async (argv) => {",
        "  const args = argv.slice(2);",
        "  if (args.length > 0 && args[0] === '--help') { process.stdout.write('cli-help'); return 0; }",
        "  process.stdout.write('argv=' + JSON.stringify(argv));",
        "  return 0;",
        "};",
        "if (typeof process !== 'undefined' && process.argv) {",
        "  void main(process.argv).then((code) => { if (process.exit) process.exit(code); });",
        "}",
      ].join('\n'),
    },
  });
  await repl.feed([
    "const cp = require('node:child_process');",
    "const r = cp.spawnSync('/bin/node', ['/tmp/fake-dpm.js', '--help']);",
    "process.stdout.write('OUT=' + Buffer.from(r.stdout).toString() + '|ERR=' + Buffer.from(r.stderr).toString() + '|STATUS=' + r.status + '\\n');",
    "",
  ].join("\n"));
  await new Promise((r) => setTimeout(r, 1000));
  const text = out.join('');
  expect(text).toContain('OUT=cli-help');
  expect(text).toContain('STATUS=0');
  repl.engine.terminate();
}, 60_000);

test('/bin/node stays alive while an HTTP server is listening', async () => {
  const relay = new NodeServerRelay();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "const server = http.createServer((_req, res) => { res.end('OK'); server.close(); });",
    "server.listen(8080, 'dusk.local');",
  ].join(' ')], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

  await waitFor(() => relay.handler !== undefined);
  const earlyExit = await Promise.race([
    handle.exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  expect(earlyExit).toBe(false);

  const socket = new NodeServerRelaySocket();
  relay.handler!(socket);
  socket.receive('GET / HTTP/1.1\r\nHost: dusk.local\r\nConnection: close\r\n\r\n');
  await waitFor(() => new TextDecoder().decode(concat(socket.sent)).includes('\r\n\r\nOK'));
  expect(await handle.exit).toBe(0);
}, 60_000);

test('/bin/node exits when an HTTP server is unrefed', async () => {
  const relay = new NodeServerRelay();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "http.createServer((_req, res) => res.end('OK')).listen(8080, 'dusk.local').unref();",
  ].join(' ')], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

  expect(await handle.exit).toBe(0);
}, 60_000);

test('/bin/node observes an HTTP server started from a queued microtask', async () => {
  const relay = new NodeServerRelay();
  const repl = await bootRepl(() => {}, { fs: 'memory', net: { relay }, skipPidZero: true });
  const handle = await repl.processManager.spawn('/bin/node', ['-e', [
    "const http = require('node:http');",
    "Promise.resolve().then(() => http.createServer(() => {}).listen(8080, 'dusk.local'));",
  ].join(' ')], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin' },
  });

  await waitFor(() => relay.handler !== undefined);
  const earlyExit = await Promise.race([
    handle.exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  expect(earlyExit).toBe(false);
  handle.kill();
}, 60_000);

const concat = (chunks: Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};
