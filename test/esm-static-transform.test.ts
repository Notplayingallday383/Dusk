import { expect, test } from 'vitest';
import { transformStaticImports } from '../src/host/esm-static-transform';

test('compiles ESM modules to System.register registrations', async () => {
  const transformed = await transformStaticImports([
    "import value from './default.js';",
    'export { value } from \'./re-export.js\';',
    'export * from \'./star-re-export.js\';',
  ].join('\n'));

  expect(transformed).toContain('System.register([');
  expect(transformed).toContain('"./default.js"');
  expect(transformed).toContain('"./re-export.js"');
  expect(transformed).toContain('"./star-re-export.js"');
});

test('lowers imports without rewriting comments, strings, templates, or regexes', async () => {
  const source = [
    "// import comment from 'ignored-comment'",
    'const text = "export * from \'ignored-string\'";',
    "const template = `import templated from 'ignored-template'`;",
    "const pattern = /import regex from 'ignored-regex'/;",
    "import value, { name as local } from './dep.js';",
  ].join('\n');

  const transformed = await transformStaticImports(source);

  expect(transformed).toContain("// import comment from 'ignored-comment'");
  expect(transformed).toContain('"export * from \'ignored-string\'"');
  expect(transformed).toContain("`import templated from 'ignored-template'`");
  expect(transformed).toContain("/import regex from 'ignored-regex'/");
  expect(transformed).toContain('System.register(["./dep.js"]');
  expect(transformed).toContain('value = _depJs.default;');
});

test('compiles dynamic imports to the SystemJS context loader', async () => {
  const source = "const module = import('./dynamic.js');";

  await expect(transformStaticImports(source)).resolves.toContain('_context.import');
});

test('compiles top-level await to an async System.register execute function', async () => {
  const transformed = await transformStaticImports('await Promise.resolve();');

  expect(transformed).toContain('System.register');
  expect(transformed).toMatch(/execute:\s*async function/);
});

test('allows await inside an async arrow function', async () => {
  const source = 'const load = async () => await Promise.resolve();';

  await expect(transformStaticImports(source)).resolves.toContain('async () => await Promise.resolve()');
});

test('allows await outside top-level await expressions', async () => {
  const source = [
    'const options = { await: true };',
    'const pattern = /await/;',
    'class Loader { async load() { await Promise.resolve(); } }',
    'async function load() { await Promise.resolve(); }',
  ].join('\n');

  await expect(transformStaticImports(source)).resolves.toContain('async function load()');
});
