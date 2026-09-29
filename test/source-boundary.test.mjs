import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function scan(directory) {
  const violations = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['node_modules', '.git', 'dist', 'lib', 'docs', 'graphify-out', '.wasm-bindgen', '__screenshots__'].includes(entry.name)) {
        violations.push(...await scan(path));
      }
      continue;
    }
    if (!/\.(?:[cm]?js|tsx?)$/.test(entry.name)) continue;
    const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
    const check = (specifier) => {
      if (!specifier || !ts.isStringLiteralLike(specifier)) return;
      const value = specifier.text.split('?')[0];
      if (!value.startsWith('.') && !value.startsWith('/')) return;
      const target = relative(root, resolve(dirname(path), value));
      if (target === '..' || target.startsWith(`..${sep}`)) violations.push(`${relative(root, path)}: ${value}`);
    };
    const visit = (node) => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) check(node.moduleSpecifier);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) check(node.arguments[0]);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return violations;
}

test('Dusk source, tests and build scripts do not import sibling workspace files', async () => {
  assert.deepEqual(await scan(root), []);
});
