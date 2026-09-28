import { expect, test } from 'vitest';
import { createMemoryBackend } from '../src/host/fs-backend';
import { createFuncs } from '../src/host/funcs';
import { createNativePackageRegistry } from '../src/host/native-package-registry';
import { createRunner } from '../src/host/runner';

test('uses an exact browser replacement instead of an installed native package entry', async () => {
  const fs = createMemoryBackend();
  const output: string[] = [];
  await fs.mkdir('/app/node_modules/native-package', { recursive: true });
  await fs.writeFile('/app/node_modules/native-package/package.json', JSON.stringify({ main: './addon.node' }));
  await fs.writeFile('/app/node_modules/native-package/addon.node', 'module.exports = { value: "native" };');
  const registry = createNativePackageRegistry({
    'native-package': 'module.exports = { value: "browser" };',
  });
  const runner = await createRunner(createFuncs(fs, (text) => output.push(text), registry));

  await runner.run("console.log(require('native-package').value);");
  runner.stop();

  expect(output.join('')).toContain('browser');
});
