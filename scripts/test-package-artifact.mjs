import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const archive = process.argv[2];
if (!archive) throw new Error('Usage: node scripts/test-package-artifact.mjs <dusk-tarball>');

const entries = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n');
const read = (path) => execFileSync('tar', ['-xOzf', archive, path], {
  encoding: 'utf8', maxBuffer: 100 * 1024 * 1024,
});
const manifest = JSON.parse(read('package/package.json'));

assert.deepEqual(manifest.exports, {
  '.': { types: './lib/types/index.d.ts', import: './lib/duskjs.js' },
});
assert.equal(manifest.dependencies['@nightnetwork/nova'], '^1.1.0');
assert.equal(manifest.dependencies['@nightnetwork/moonbeam'], '^1.1.1');
assert.equal(manifest.dependencies['@nightnetwork/dpm'], '1.0.0');
assert.ok(!JSON.stringify(manifest).includes('file:'));
for (const path of ['package/lib/duskjs.js', 'package/lib/types/index.d.ts']) {
  assert.ok(entries.includes(path), `Missing ${path}`);
}
const bundle = read('package/lib/duskjs.js');
assert.ok(!bundle.includes('Internal Babel error'), 'Initial library bundle contains the Babel payload');
const babelChunk = entries.find((entry) => /^package\/lib\/chunks\/(?:babel|standalone)-.*\.js$/.test(entry));
assert.ok(babelChunk, 'Missing lazy Babel chunk');
assert.match(read(babelChunk), /Internal Babel error/, 'Lazy Babel chunk does not contain the Babel payload');
for (const [name, variable, pattern] of [
  ['esbuild browser API', 'esbuildBrowserUrl', /^package\/lib\/(?:assets\/)?browser\.min(?:-[\w-]+)?\.js$/],
  ['esbuild WASM', 'esbuildWasmUrl', /^package\/lib\/(?:assets\/)?esbuild(?:-[\w-]+)?\.wasm$/],
]) {
  const asset = entries.find((entry) => pattern.test(entry));
  assert.ok(asset, `Missing packed ${name}`);
  const reference = bundle.match(new RegExp(`const ${variable} = [^;]*new URL\\("([^"\\n]+)", import\\.meta\\.url\\)\\.href;`));
  assert.ok(reference, `Bundled engine does not resolve ${name} relative to import.meta.url`);
  const resolved = new URL(reference[1], 'https://consumer.example/node_modules/@nightnetwork/dusk/lib/duskjs.js');
  assert.equal(resolved.pathname, `/node_modules/@nightnetwork/dusk/${asset.slice('package/'.length)}`);
  assert.ok(execFileSync('tar', ['-xOzf', archive, asset], { maxBuffer: 100 * 1024 * 1024 }).byteLength > 0, `Empty packed ${name}`);
}
assert.ok(entries.includes('package/ESBUILD-LICENSE.md'), 'Missing vendored esbuild license');
assert.match(read('package/ESBUILD-LICENSE.md'), /MIT License[\s\S]*Evan Wallace/);
assert.ok(entries.includes('package/LICENSE'), 'Missing Dusk license');
const license = read('package/LICENSE');
assert.match(license, /Apache License\s+Version 2\.0, January 2004/);
assert.match(license, /3\. Grant of Patent License\.[\s\S]*9\. Accepting Warranty or Additional Liability\.[\s\S]*END OF TERMS AND CONDITIONS/);
assert.match(license, /Copyright 2026 Night Network/);
assert.match(bundle, /import\("@nightnetwork\/dpm"\)/, 'Dusk does not load its declared DPM dependency');
assert.ok(!entries.some((path) => /^package\/lib\/chunks\/dpm_wasm-.*\.js$/.test(path)), 'Dusk redundantly bundles DPM JavaScript');
const dpmWasm = entries.find((path) => /^package\/lib\/(?:assets\/)?dpm_wasm_bg(?:-[\w-]+)?\.wasm$/.test(path));
assert.ok(dpmWasm, 'Missing packed DPM WASM asset');
const dpmReference = bundle.match(/const dpmWasmUrl = [^;]*new URL\("([^"\n]+)", import\.meta\.url\)\.href;/);
assert.ok(dpmReference, 'Dusk does not resolve the DPM WASM asset relative to import.meta.url');
assert.equal(
  new URL(dpmReference[1], 'https://consumer.example/node_modules/@nightnetwork/dusk/lib/duskjs.js').pathname,
  `/node_modules/@nightnetwork/dusk/${dpmWasm.slice('package/'.length)}`,
);
assert.ok(!entries.some((path) => path.startsWith('package/src/') || path.includes('nova_wasm_bg')), 'Unexpected source or bundled Nova asset');

let maps = 0;
for (const path of entries.filter((entry) => /\.(?:js|d\.ts)(?:\.map)?$/.test(entry))) {
  const content = read(path);
  assert.ok(!/(?:\/home\/amplify\/|\/Users\/[^/\s]+\/(?:Projects|Documents)\/|[A-Za-z]:\\Users\\[^\\\s]+\\(?:Projects|Documents)\\|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|npm_[A-Za-z0-9]{30,})/.test(content), `Sensitive content or absolute workstation path in ${path}`);
  if (!path.endsWith('.map')) continue;
  maps++;
  const map = JSON.parse(content);
  assert.ok(Array.isArray(map.sourcesContent), `Missing sourcesContent in ${path}`);
  assert.equal(map.sourcesContent.length, (map.sources ?? []).length, `sourcesContent length mismatch in ${path}`);
  assert.ok(map.sourcesContent.every((source) => typeof source === 'string'), `Non-string sourcesContent in ${path}`);
  for (const source of map.sources ?? []) {
    assert.ok(!/^(?:\/|[A-Za-z]:[\\/])/.test(source), `Absolute source path in ${path}`);
  }
}
console.log(`Verified ${entries.length} packed entries and ${maps} source maps`);
