// DuskJS in-engine world (runs inside js.wasm). No DOM. Loaded as raw text.
import { installNodeGlobals } from './node-globals';
import { installRequire } from './require';
import { installESM } from './esm';
import { installNet } from './net';

if (typeof (globalThis as { ipc?: unknown }).ipc === 'undefined') {
  (globalThis as Record<string, unknown>).evalQueue = [];
  (globalThis as Record<string, unknown>).ipc = {
    send: (msg: unknown, ignoreEval = true) => {
      print(JSON.stringify(msg));
      return (globalThis as { ipc: { recv: (i: boolean) => unknown } }).ipc.recv(ignoreEval);
    },
    recv: (ignoreEval: boolean) => {
      while (true) {
        const read = readline();
        if (!read) continue;
        const str = os.file.readFile('/comm');
        let msg: { type?: string; js?: string };
        if (str.startsWith('JS|')) msg = { type: 'eval', js: str.slice(3) };
        else msg = JSON.parse(str);
        if (msg.type === 'eval') {
          (globalThis as { evalQueue: unknown[] }).evalQueue.push(msg);
          if (ignoreEval) continue;
        }
        return msg;
      }
    },
  };
}

declare const drainJobQueue: (() => void) | undefined;

const ipc = (globalThis as { ipc: { send: (m: unknown, i?: boolean) => { js?: string } } }).ipc;

installNodeGlobals();
installRequire();
installESM();
installNet();

while (true) {
  const reply = ipc.send({ type: 'wait' }, false);
  const js = (reply.js ?? '').replace(/\bimport\s*\(/g, '__import__(');
  try { (0, eval)('(async () => {' + js + '\n})()'); if (typeof drainJobQueue === 'function') drainJobQueue(); } catch (e) { print(JSON.stringify({ f: 'console.error', args: [String(e)] })); }
  ipc.send({ type: 'done' });
}
