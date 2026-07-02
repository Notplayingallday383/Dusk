// @ts-nocheck — DuskJS stub. sqlite3 requires sql.js WASM which isn't
// wired into the engine yet. Errors at runtime with a clear message.
const notSupported = async () => ({
  stdout: "",
  stderr: "sqlite3: not supported in DuskJS engine (sql.js not loaded)\n",
  exitCode: 127,
});

export const sqlite3Command = { name: "sqlite3", execute: notSupported };
