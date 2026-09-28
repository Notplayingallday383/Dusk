import { describe, expect, test } from 'vitest';
import config from '../vite.lib.config.ts?raw';
import dpmLoader from '../src/host/dpm-wasm.ts?raw';
import esmTransform from '../src/host/esm-static-transform.ts?raw';

describe('DuskJS library build config', () => {
	test('uses package-relative asset URLs', () => {
		expect(config).toMatch(/base:\s*'\.\/'/);
	});

	test('leaves the Nova artifact to the consuming application', () => {
		expect(config).toContain("'@nightnetwork/nova'");
	});

	test('leaves DPM JavaScript external while packing its explicit WASM asset', () => {
		expect(config).toContain("'@nightnetwork/dpm'");
	});

	test('loads the published DPM module with its Vite-resolved WASM asset', () => {
		expect(dpmLoader).toContain("from '@nightnetwork/dpm/wasm?url&no-inline'");
		expect(dpmLoader).toContain("import('@nightnetwork/dpm')");
		expect(dpmLoader).not.toContain("./dpm-wasm/pkg/dpm_wasm.js");
	});

	test('loads Babel dynamically from the transform boundary', () => {
		expect(esmTransform).not.toMatch(/^import .*@babel\/standalone/m);
		expect(esmTransform).toContain("import('@babel/standalone')");
	});

	test('documents Vite browser consumers without promising bare esbuild support', () => {
		expect(config).toContain('Vite browser consumers');
		expect(config).toContain('Bare esbuild browser bundling requires a custom worker/asset pipeline');
		expect(config).not.toContain('import from any bundler');
	});
});
