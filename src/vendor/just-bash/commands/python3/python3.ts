// @ts-nocheck — DuskJS stub. Python 3 support needs CPython WASM.
const notSupported = async () => ({
  stdout: "",
  stderr: "python3: not supported in DuskJS engine\n",
  exitCode: 127,
});
export const python3Command = { name: "python3", execute: notSupported };
