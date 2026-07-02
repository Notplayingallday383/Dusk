// @ts-nocheck — DuskJS stub. curl uses just-bash's SecureFetch which isn't
// wired into the engine yet. Errors at runtime with a clear message.
const notSupported = async () => ({
  stdout: "",
  stderr: "curl: not supported in DuskJS engine (network bridge not wired)\n",
  exitCode: 127,
});
export const curlCommand = { name: "curl", execute: notSupported };
