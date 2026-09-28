import { expect, test } from 'vitest';
import readme from '../README.md?raw';
import * as nova from '@nightnetwork/nova';
import { createEngineFactory, createNativeEngine, createSpiderMonkeyLegacyEngine } from '../src/host/engine-instance';

test('README initializes Nova through its namespace export', () => {
  expect(readme).toContain("import * as nova from '@nightnetwork/nova';");
  expect(readme).toContain('await nova.default();');
  expect(readme).toContain('new nova.LibCurl()');
  expect(readme).not.toMatch(/import nova from ['"]@nightnetwork\/nova['"]/);
  expect(typeof nova.default).toBe('function');
  expect(typeof nova.LibCurl).toBe('function');
});

test('Quick Start sends string output to a browser-safe callback', () => {
  const quickStart = readme.split('## Quick Start\n')[1]?.split('\n### ')[0];
  expect(quickStart).toBeDefined();
  expect(quickStart).toMatch(/bootRepl\(\(text\) => console\.log\(text\)\)/);
  expect(quickStart).not.toContain('process.stdout');
});

test('README runtime claims match the source runtime selection', () => {
  expect(createEngineFactory()).toBe(createNativeEngine);
  expect(createEngineFactory('spidermonkey-legacy')).toBe(createSpiderMonkeyLegacyEngine);
  const introduction = readme.split('## Features')[0];
  const architecture = readme.split('## Architecture')[1]?.split('## Browser Requirements')[0];
  expect(introduction).toMatch(/native JavaScript.*Web Worker/);
  expect(introduction).not.toMatch(/powered by SpiderMonkey WASI|boots a SpiderMonkey engine per process/);
  expect(architecture).toMatch(/native.*Web Worker/);
  expect(architecture).toMatch(/spidermonkey-legacy.*SpiderMonkey WASI/);
  expect(readme).toMatch(/Engine pool.*spidermonkey-legacy/);
  expect(readme).not.toMatch(/pid-0 SpiderMonkey engine|Each process runs in its own SpiderMonkey WASI Web Worker/);
});

test('README installation describes the tested consumer and bare esbuild limits', () => {
  const installation = readme.split('## Installation')[1]?.split('## Quick Start')[0];
  expect(installation).toMatch(/Vite.*browser consumer/);
  expect(installation).toContain('Cross-Origin-Opener-Policy: same-origin');
  expect(installation).toContain('Cross-Origin-Embedder-Policy: require-corp');
  expect(installation).toMatch(/bare esbuild.*custom worker\/asset pipeline/i);
  expect(installation).toMatch(/Pyodide.*node:\*/);
});
