// Stub for node:dns in the engine bundle.
//
// just-bash's network/fetch.ts imports `lookup` from node:dns for DNS
// resolution before fetch. In the DuskJS engine there is no real DNS —
// libcurl (host-side) handles resolution. Runtime callers into this stub
// error; imports resolve so the bundle links.
const notSupported = (fnName) => () => {
  throw new Error("jsh: node:dns is not available in the DuskJS engine (called " + fnName + ")");
};

export const lookup = notSupported("lookup");
export const resolve = notSupported("resolve");
export const resolve4 = notSupported("resolve4");
export const resolve6 = notSupported("resolve6");
export const reverse = notSupported("reverse");

export default { lookup, resolve, resolve4, resolve6, reverse };
