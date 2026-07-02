import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';

test('node:os exposes platform, arch, EOL, tmpdir, homedir, hostname, cpus', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed(
    "const os = require('node:os'); " +
    "process.stdout.write('OS:' + os.platform() + '|' + os.arch() + '|' + JSON.stringify(os.EOL) + '|' + os.tmpdir() + '|' + os.homedir() + '|' + os.hostname() + '|cpus=' + os.cpus().length + '|freemem=' + os.freemem() + '|totalmem=' + os.totalmem() + '|ifaces=' + JSON.stringify(os.networkInterfaces()) + ':END');\n"
  );
  repl.engine.terminate();
  const s = out.join('');
  expect(s).toContain('OS:linux|wasm32|"\\n"|/tmp|');
  expect(s).toMatch(/cpus=1/);
  expect(s).toMatch(/freemem=0/);
  expect(s).toMatch(/totalmem=0/);
  expect(s).toMatch(/ifaces=\{\}/);
  expect(s).toContain(':END');
}, 60_000);
