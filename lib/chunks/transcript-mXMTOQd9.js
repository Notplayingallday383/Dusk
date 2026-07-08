const TRANSCRIPT_LINES = [
  "1 + 1",
  'const greeting = "hello from DuskJS"',
  "greeting",
  'require("./mod.js").answer',
  '(await import("./esm.mjs")).value',
  'const path = require("node:path"); path.join("/a", "b", "c.txt")',
  'const fs = require("node:fs")',
  'await fs.promises.mkdir("/demo", { recursive: true })',
  'await fs.promises.writeFile(path.join("/demo", "hello.txt"), "hi from node:fs")',
  'await fs.promises.readdir("/demo")',
  'await fs.promises.readFile("/demo/hello.txt")',
  'path.resolve("/demo", "..", "demo", "./hello.txt")',
  'fetch("https://example.com").then(r => r.text()).then(t => t.length)',
  "process.pid",
  "process.cwd()",
  'process.env.PATH = "/bin"; process.env.PATH',
  'const cp = require("node:child_process")',
  'cp.spawnSync("/bin/echo", ["hello", "from", "spawn"]).stdout',
  'cp.spawnSync("/bin/sh", ["-c", "echo hi && echo bye"]).stdout',
  'cp.spawnSync("/bin/sh", ["-c", "echo $0 $1 $2", "a", "b", "c"]).stdout',
  'cp.spawnSync("/bin/sh", ["-c", "true && /bin/echo ok || /bin/echo fail"]).stdout',
  'cp.spawnSync("/bin/pwd", [], { cwd: "/demo" }).stdout',
  'cp.execSync("/bin/echo piped | /bin/cat")',
  'await new Promise((res) => cp.exec("echo from exec", (e, out) => res(out)))',
  'const child = cp.spawn("/bin/sh", ["-c", "echo streamed"]); await new Promise((r) => child.on("exit", r)); child.stdout'
];
const TRANSCRIPT_SEED = {
  "/mod.js": "module.exports = { answer: 42 };",
  "/esm.mjs": "export const value = 7;"
};
const makeStubLibcurl = () => ({
  load_wasm: async () => {
  },
  set_websocket: (_url) => {
  },
  fetch: async (_url, _opts) => ({
    status: 200,
    statusText: "OK",
    headers: /* @__PURE__ */ new Map([["content-type", "text/plain"]]),
    text: async () => "hello world"
  }),
  WebSocket: class {
    constructor(_url, _protocols) {
    }
    addEventListener() {
    }
    send() {
    }
    close() {
    }
  }
});
export {
  TRANSCRIPT_LINES as T,
  TRANSCRIPT_SEED as a,
  makeStubLibcurl as m
};
//# sourceMappingURL=transcript-mXMTOQd9.js.map
