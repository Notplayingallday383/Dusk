export const esbuildWasmReplacementSource = `
const api = globalThis.__DUSK_ESBUILD_WASM__;
if (!api) throw new Error('esbuild-wasm is unavailable in this Dusk worker');
const esbuild = {
  context: api.context,
  build: api.build,
  transform: api.transform,
  formatMessages: api.formatMessages,
  version: api.version,
};
module.exports = esbuild;
module.exports.default = esbuild;
`;
