// @ts-nocheck — DuskJS stub. xan (CSV utility) not vendored yet.
const notSupported = async () => ({
  stdout: "",
  stderr: "xan: not supported in DuskJS engine\n",
  exitCode: 127,
});

export const xanCommand = { name: "xan", execute: notSupported };
