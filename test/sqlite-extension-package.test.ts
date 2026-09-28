import { expect, test } from 'vitest';
import extensionManifest from '../../extensions/dusk-sqlite/package.json';

test('SQLite extension publishes a Dusk peer contract without workspace imports', () => {
  expect(extensionManifest.exports).toEqual({ '.': './src/host.ts' });
  expect(extensionManifest.peerDependencies?.['@nightnetwork/dusk']).toBe('^1.0.0');
  expect(JSON.stringify(extensionManifest)).not.toContain('file:');
});
