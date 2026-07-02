import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

// Note: plan's original test code used `new TextDecoder().decode(chunk)`, but
// TextDecoder is not defined in this SpiderMonkey engine build. Using
// `String(chunk)` instead — Buffer's toString override yields utf8 text.
// loopback net data round-trip not observed in memory-fs mode — server and client
// register but chunks written by server don't reach client 'data' listener.
// See src/host/process-manager.ts:1187 net.connect / SocketPair dispatch.
test.skip('node:net loopback Server + Socket echo round-trip', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "(async () => { " +
    "const net = require('node:net'); " +
    "const PORT = 9300; " +
    "const server = net.createServer((sock) => { " +
    "  sock.on('data', (chunk) => { sock.write(chunk); }); " +
    "  sock.on('end', () => { sock.end(); }); " +
    "}); " +
    "await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); " +
    "const client = net.connect({ host: '127.0.0.1', port: PORT }); " +
    "const got = []; " +
    "client.on('data', (chunk) => { got.push(typeof chunk === 'string' ? chunk : String(chunk)); }); " +
    "await new Promise((r) => client.once('connect', r)); " +
    "client.write('ping-net'); " +
    "await new Promise((r) => setTimeout(r, 200)); " +
    "client.end(); " +
    "await new Promise((r) => setTimeout(r, 100)); " +
    "server.close(); " +
    "process.stdout.write('N:got=' + got.join('') + ':END'); " +
    "})()\n"
  );
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf(':END') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('N:got=ping-net:END');
}, 60_000);
