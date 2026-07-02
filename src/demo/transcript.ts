import type { LibCurl } from '../host/net';

export const TRANSCRIPT_LINES: string[] = [
  '1 + 1',
  'const greeting = "hello from DuskJS"',
  'greeting',
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
  'process.pid',
  'process.cwd()',
  'process.env.PATH = "/bin"; process.env.PATH',
  'const cp = require("node:child_process")',
  'cp.spawnSync("/bin/echo", ["hello", "from", "spawn"]).stdout',
  'cp.spawnSync("/bin/sh", ["-c", "echo hi && echo bye"]).stdout',
  'cp.spawnSync("/bin/sh", ["-c", "echo $0 $1 $2", "a", "b", "c"]).stdout',
  'cp.spawnSync("/bin/sh", ["-c", "true && /bin/echo ok || /bin/echo fail"]).stdout',
  'cp.spawnSync("/bin/pwd", [], { cwd: "/demo" }).stdout',
  'cp.execSync("/bin/echo piped | /bin/cat")',
  'await new Promise((res) => cp.exec("echo from exec", (e, out) => res(out)))',
  'const child = cp.spawn("/bin/sh", ["-c", "echo streamed"]); await new Promise((r) => child.on("exit", r)); child.stdout',
];

export const TRANSCRIPT_SEED: Record<string, string> = {
  '/mod.js': 'module.exports = { answer: 42 };',
  '/esm.mjs': 'export const value = 7;',
};

export const makeStubLibcurl = (): LibCurl =>
  ({
    load_wasm: async () => {},
    set_websocket: (_url: string) => {},
    fetch: async (_url: string, _opts?: unknown) =>
      ({
        status: 200,
        statusText: 'OK',
        headers: new Map<string, string>([['content-type', 'text/plain']]),
        text: async () => 'hello world',
      }) as unknown as Response,
    WebSocket: class {
      constructor(_url: string, _protocols?: string[]) {}
      addEventListener() {}
      send() {}
      close() {}
    } as unknown as new (url: string, protocols?: string[]) => WebSocket,
  }) as LibCurl;
