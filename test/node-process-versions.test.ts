import { test, expect } from 'vitest';
import { bootRepl } from '../src/index';
import pkg from '../package.json';

test('process.versions.dusk equals package.json version (via __DUSK_VERSION__ define)', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("process.stdout.write('dusk=' + process.versions.dusk + '\\n')\n");
  repl.engine.terminate();
  expect(out.join('')).toContain('dusk=' + pkg.version);
  expect(pkg.version).not.toBe('0.0.0'); // ensure the assertion is non-trivial
}, 60_000);

test('process.versions.spidermonkey is intentionally "0" until SM exposes a version channel', async () => {
  // Audit reference: src/engine/spidermonkey.ts has no version metadata —
  // the wasm is fetched from SM_DATA_URL and no version field is exposed.
  // This test exists so the next person to touch this knows the value is
  // intentional, not stale. If SM ever publishes a version, update the
  // node-process.ts bootstrap and replace this assertion.
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed("console.error('sm=' + process.versions.spidermonkey)\n");
  repl.engine.terminate();
  expect(out.join('')).toContain('sm=0');
}, 60_000);
