import rollupBrowserSource from './rollup-browser/rollup.browser.js?raw';

const exportsMarker = 'e.VERSION=n,e.defineConfig=function(e){return e},e.rollup=';
const wasmMarker = 'await jn()}();';
const browserFsBindings = 'Tc=Bc("fs.mkdir"),zc=Bc("fs.readFile"),Vc=Bc("fs.writeFile")';
const guestFsBindings = 'Tc=(...e)=>require("node:fs/promises").mkdir(...e),zc=(...e)=>require("node:fs/promises").readFile(...e),Vc=(...e)=>require("node:fs/promises").writeFile(...e)';

const browserSource = rollupBrowserSource
  // @rollup/browser keeps its parser private. Export the exact bundled parser
  // for Vite's documented rollup/parseAst dependency.
  .replace(exportsMarker, 'e.VERSION=n,e.parseAst=Wa,e.parseAstAsync=async function(e,t){return Wa(e,t)},e.defineConfig=function(e){return e},e.rollup=')
  // The host delivers the official static asset before guest code starts.
  .replace(wasmMarker, 'await jn(globalThis.__DUSK_ROLLUP_BROWSER_WASM_BYTES__)}();')
  // The browser build hardwires these private bindings to no-FS errors.
  .replace(browserFsBindings, guestFsBindings);

if (!browserSource.includes('e.parseAst=Wa') || !browserSource.includes('__DUSK_ROLLUP_BROWSER_WASM_BYTES__') || !browserSource.includes(guestFsBindings)) {
  throw new Error('Unexpected @rollup/browser 4.20.0 bundle shape');
}

export const rollupBrowserReplacementSource = `
eval(${JSON.stringify(browserSource)});
`;

export const rollupParseAstReplacementSource = `
eval(${JSON.stringify(browserSource)});
module.exports = {
  parseAst: module.exports.parseAst,
  parseAstAsync: module.exports.parseAstAsync,
};
`;
