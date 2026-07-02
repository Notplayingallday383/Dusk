// @ts-nocheck — DuskJS stub. gzip/gunzip/zcat depend on node:zlib which the
// engine doesn't provide. These commands error at runtime with a clear message.
const notSupported = (name) => async () => ({
  stdout: "",
  stderr: name + ": not supported in DuskJS engine (node:zlib unavailable)\n",
  exitCode: 127,
});

export const gzipCommand = { name: "gzip", execute: notSupported("gzip") };
export const gunzipCommand = { name: "gunzip", execute: notSupported("gunzip") };
export const zcatCommand = { name: "zcat", execute: notSupported("zcat") };
