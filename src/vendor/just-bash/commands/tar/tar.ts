// @ts-nocheck — DuskJS stub. tar depends on modern-tar which is heavy and
// only sometimes needed. Errors at runtime with a clear message.
const notSupported = async () => ({
  stdout: "",
  stderr: "tar: not supported in DuskJS engine\n",
  exitCode: 127,
});

export const tarCommand = { name: "tar", execute: notSupported };
