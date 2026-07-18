import { describe, expect, test } from 'vitest';
import config from '../vite.lib.config.ts?raw';

describe('DuskJS library build config', () => {
	test('uses package-relative asset URLs', () => {
		expect(config).toMatch(/base:\s*'\.\/'/);
	});
});
