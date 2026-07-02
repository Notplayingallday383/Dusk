// @ts-nocheck — DuskJS stub. html-to-markdown uses turndown; not vendored.
const notSupported = async () => ({
  stdout: "",
  stderr: "html-to-markdown: not supported in DuskJS engine\n",
  exitCode: 127,
});

const htmlToMarkdownCommand = { name: "html-to-markdown", execute: notSupported };
export default htmlToMarkdownCommand;
export { htmlToMarkdownCommand };
