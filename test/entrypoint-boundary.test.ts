import { describe, expect, test } from 'vitest';
import indexSource from '../src/index.ts?raw';

describe('DuskJS library entrypoint boundary', () => {
	test('src/index.ts has no top-level document access', () => {
		expect(indexSource).not.toMatch(/^[^\n]*\bdocument\b/m);
		expect(indexSource).not.toMatch(/typeof\s+document/);
	});

	test('src/index.ts has no top-level side-effect IIFE', () => {
		expect(indexSource).not.toMatch(/^\s*void\s*\(async/m);
		expect(indexSource).not.toMatch(/^\s*\(async\s*\(\s*\)\s*=>/m);
	});

	test('importing src/index exposes the library API without throwing', async () => {
		const mod = await import('../src/index');
		expect(typeof mod.bootRepl).toBe('function');
		expect(Object.keys(mod)).toContain('ProcessManager');
		expect(Object.keys(mod)).toContain('startRepl');
	});
});
