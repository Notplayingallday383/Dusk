# @nightnetwork/dusk — DuskJS

**Node.js in a browser tab.** A browser-hosted JavaScript runtime with Node.js-compatible APIs.

DuskJS runs native JavaScript inside Web Workers by default, with SpiderMonkey WASI available only through `runtime: 'spidermonkey-legacy'`. It provides familiar `node:*` modules, a POSIX shell, Python via Pyodide, persistent storage, and networking through browser-supported transports and optional relays.

## Features

- **Native worker engine** — JavaScript processes run in isolated Web Workers by default; SpiderMonkey WASI is opt-in with `runtime: 'spidermonkey-legacy'`
- **Node.js core modules** — `node:http`, `node:net`, `node:fs`, `node:crypto`, `node:path`, `node:os`, `node:child_process`, `node:stream`, `node:events`, `node:buffer`, `node:url`, `node:querystring`, `node:zlib`, and more
- **POSIX shell (dsh)** — built-in shell with `grep`, `sed`, `awk`, `jq`, `sort`, `uniq`, `find`, `head`, `tail`, `wc`, `cat`, `ls`, `mkdir`, `rm`, `cp`, `mv`, `chmod`, `env`, `echo`, `printf`, `test`, `xargs`, `tee`, `tr`, `cut`, `basename`, `dirname`, `date`, `sleep`, `true`, `false`, `yes`, pipes, redirects, variables, and control flow
- **Interactive Node REPL** — `/bin/node` with persistent context across evaluations
- **SQLite extension** — install `@nightnetwork/dusk-sqlite`, then restart with its explicitly imported host extension
- **Python** — via Pyodide, accessible from the shell (`python3`) with full stdlib
- **Persistent filesystem (TFS/OPFS)** — files survive page reloads using Origin Private File System
- **PTY support** — full pseudo-terminal with line discipline, echo, `^C`/`^D` handling, and `SIGWINCH` resize
- **DPM package manager** — Rust browser package manager behind `dpm`, `dpx`, `npm`, `npx`, and `pnpm`; it installs verified registry, HTTPS tarball, local tarball, and workspace packages
- **MoonBeam relay networking** — connect processes to external servers via WebSocket relay
- **Nova HTTP client** — `@nightnetwork/nova`, the Rust/WASM `libcurl` replacement for outbound HTTP/HTTPS
- **Engine pool** — pre-compiles SpiderMonkey WASI for `spidermonkey-legacy` only; native workers spawn on demand
- **Signal delivery** — SIGINT, SIGTERM, SIGKILL, SIGCHLD, SIGWINCH, and more

## Installation

```bash
npm install @nightnetwork/dusk
```

The published package is tested as a Vite browser consumer. Serve the app in a cross-origin-isolated context (COOP/COEP) so Dusk can use `SharedArrayBuffer` for worker IPC:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The library build is not bundler-agnostic: bare esbuild requires a custom worker/asset pipeline to emit and serve Dusk's worker scripts and WASM assets, plus handling for Pyodide's `node:*` imports. Bare esbuild is not supported out of the box.

## Quick Start

```ts
import { bootRepl } from '@nightnetwork/dusk';

const repl = await bootRepl((text) => console.log(text));

// Evaluate JavaScript
await repl.feed('console.log("Hello from DuskJS!")');

// Access the process manager to spawn shell commands
const sh = await repl.processManager.spawn('/bin/dsh', ['-c', 'echo hello | sed s/hello/world/']);

// Clean up
await repl.engine.terminate();
```

### Spawn an interactive shell (browser)

```ts
import { bootRepl } from '@nightnetwork/dusk';

const repl = await bootRepl(write, {
  skipPidZero: true, // saves ~100MB RAM
});

const sh = await repl.processManager.spawn('/bin/dsh', [], {
  cwd: '/home/user',
  env: { HOME: '/home/user', PATH: '/bin', TERM: 'xterm-256color', USER: 'user' },
  pty: { cols: 80, rows: 24 },
});

// Wire PTY master to your terminal UI
sh.master.onMasterData((bytes) => terminal.write(bytes));

// Send user input
await sh.stdin.write(new TextEncoder().encode('ls /bin\n'));
```

### SQLite extension

SQLite is intentionally not part of the base Dusk bundle. In the Dusk project, install it with `dpm install @nightnetwork/dusk-sqlite`; after the install completes, restart Dusk and activate the host package explicitly:

```ts
import { bootRepl } from '@nightnetwork/dusk';
import { createSqliteExtension } from '@nightnetwork/dusk-sqlite';

await bootRepl(write, {
  extensionCwd: '/project',
  extensions: [createSqliteExtension()],
});
```

The activation checks the installed package's versioned `dusk.extension` capability manifest and its DPM lockfile integrity before registering `/bin/sqlite3` and `sqlite.*` IPC functions. Restarting is required; installed package files are never executed by Dusk directly.

## API Reference

### `bootRepl(write, options?): Promise<BootReplResult>`

The main entry point. Boots the runtime, initializes the filesystem, and optionally creates a pid-0 REPL engine.

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `write` | `(text: string) => void` | Callback for stdout/stderr output |
| `options` | `BootReplOptions` | Optional configuration |

**`BootReplOptions`:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `net` | `BootReplNetOptions` | `undefined` | Networking configuration (libcurl or relay) |
| `runtime` | `'native' \| 'spidermonkey-legacy'` | `'native'` | Select the native worker engine or opt into SpiderMonkey WASI |
| `seed` | `Record<string, string>` | `{}` | Pre-populate files in the virtual filesystem |
| `fs` | `'tfs' \| 'memory'` | `'tfs'` | Filesystem backend — `tfs` persists via OPFS, `memory` is ephemeral |
| `user` | `string` | `'user'` | Username for the environment |
| `hostname` | `string` | `'duskjs'` | Hostname for the environment |
| `layout` | `boolean` | `true` | Use the layered filesystem layout (ephemeral + persistent) |
| `via` | `'startRepl' \| 'node'` | `'startRepl'` | How `feed()` routes input — via the pid-0 engine or a spawned `/bin/node` |
| `skipPidZero` | `boolean` | `false` | Skip creating the pid-0 engine to save ~100MB RAM |
| `ssh` | `SshOptions` | `undefined` | Host-supplied SSH adapter, explicit host-key policy, and explicit LunaSSH WASM URLs |

### SSH Adapter

Dusk does not bundle LunaSSH or its WASM assets. The host supplies an adapter and both asset URLs explicitly:

```ts
import { bootRepl } from '@nightnetwork/dusk';
import { createDuskSshAdapter } from '@nightnetwork/lunassh/dusk';

await bootRepl(write, {
  net: { relay },
  ssh: {
    adapter: createDuskSshAdapter(),
    hostKeyVerification: { knownHosts: ['host ssh-ed25519 AAAA...'] },
    wasm: {
      wasmPath: '/assets/lunassh.wasm',
      wasmExecPath: '/assets/wasm_exec.js',
    },
  },
});
```

Use `{ insecureSkipHostKeyVerification: true }` only when an explicit insecure opt-out is intended.

**`BootReplResult`:**

| Property | Type | Description |
|----------|------|-------------|
| `feed` | `(line: string) => Promise<void>` | Send a line of input to the REPL |
| `processManager` | `ProcessManager` | Spawn and manage child processes |
| `engine` | `EngineInstance` | The pid-0 worker engine (stub if `skipPidZero`) |
| `node` | `DuskProcessHandle?` | Present when `via: 'node'` |

### `ProcessManager`

Manages the process tree, binary registry, and inter-process communication.

**Key methods:**

| Method | Description |
|--------|-------------|
| `spawn(cmd, args?, options?)` | Spawn an async child process, returns `DuskProcessHandle` |
| `spawnSync(cmd, args?, options?)` | Spawn a process and wait for completion |
| `getProcess(pid)` | Get a process handle by PID |
| `activePids()` | List all running PIDs |
| `listBinaries()` | List all registered binary paths |
| `resizePty(pid, cols, rows)` | Resize the PTY attached to a process |

**`SpawnOptions`:**

| Option | Type | Description |
|--------|------|-------------|
| `args` | `string[]` | Command arguments |
| `env` | `Record<string, string>` | Environment variables |
| `cwd` | `string` | Working directory |
| `stdin` | `Uint8Array \| string` | Initial stdin data |
| `pty` | `boolean \| { cols?, rows? }` | Attach a pseudo-terminal |

**`DuskProcessHandle`:**

| Property | Type | Description |
|----------|------|-------------|
| `pid` | `number` | Process ID |
| `exit` | `Promise<number>` | Resolves with the exit code |
| `stdin` | `ProcessStdinWriter` | Write to the process stdin (`.write()`, `.close()`) |
| `stdout` | `ReadableStream<Uint8Array>` | Process stdout |
| `stderr` | `ReadableStream<Uint8Array>` | Process stderr |
| `kill()` | `void` | Terminate the process |
| `master` | `Pty?` | PTY master (present if spawned with `pty`) |

### Other Exports

| Export | Description |
|--------|-------------|
| `createEngine` | Create a standalone native worker engine instance |
| `createRunner` | Low-level engine runner |
| `startRepl` | Create a REPL interface on an existing engine |
| `createMemoryBackend` | Ephemeral in-memory filesystem backend |
| `createTfsBackend` | Persistent TFS/OPFS filesystem backend |
| `createLayoutBackend` | Layered filesystem (ephemeral over persistent) |
| `initEnginePool` / `isPoolWarm` | Pre-compile SpiderMonkey WASI for the legacy runtime only |
| `prewarmEngine` | Pre-compile the legacy SpiderMonkey WASM binary |

## Shell Commands (dsh)

`dsh` is the default shell, providing a POSIX-compatible environment with built-in commands:

| Category | Commands |
|----------|----------|
| **Core** | `echo`, `printf`, `test`, `true`, `false`, `yes`, `exit`, `cd`, `pwd`, `env`, `export`, `unset`, `set` |
| **Files** | `ls`, `cat`, `head`, `tail`, `cp`, `mv`, `rm`, `mkdir`, `rmdir`, `touch`, `chmod`, `stat`, `find`, `ln`, `readlink` |
| **Text** | `grep`, `sed`, `awk`, `sort`, `uniq`, `wc`, `cut`, `tr`, `tee`, `xargs`, `basename`, `dirname` |
| **JSON** | `jq` |
| **Misc** | `date`, `sleep`, `whoami`, `hostname`, `uname`, `which`, `type` |
| **Node** | `node`, `js-exec` (inline JS evaluation) |
| **Python** | `python3`, `python` (via Pyodide host IPC) |
| **Packages** | `dpm`, `dpx`, `npm`, `npx`, `pnpm` |

Shell features: pipes (`|`), redirects (`>`, `>>`, `<`), variables (`$VAR`), subshells, `&&`/`||` chaining, backtick/`$()` command substitution.

## Node.js Compatibility

| Module | Status | Notes |
|--------|--------|-------|
| `node:fs` | ✅ Implemented | Sync and async APIs, `readFile`, `writeFile`, `readdir`, `stat`, `mkdir`, `rm`, streams, `watch` (partial) |
| `node:path` | ✅ Implemented | Full POSIX path module |
| `node:os` | ✅ Implemented | `platform()`, `homedir()`, `hostname()`, `tmpdir()`, `cpus()`, `networkInterfaces()` |
| `node:crypto` | ✅ Implemented | Hashes (MD5/SHA-1/SHA-256/SHA-512), HMAC, PBKDF2, AES-CBC/CTR/GCM, RSA/EC key pairs, sign/verify, randomBytes/UUID |
| `node:http` | ✅ Implemented | `createServer`, `request`, `get`, full `IncomingMessage`/`ServerResponse` |
| `node:net` | ✅ Implemented | `Socket`, `Server`, `createServer`, `createConnection` |
| `node:child_process` | ✅ Implemented | `spawn`, `spawnSync`, `exec`, `execSync`, `fork` |
| `node:stream` | ✅ Implemented | `Readable`, `Writable`, `Duplex`, `Transform`, `pipeline` |
| `node:events` | ✅ Implemented | Full `EventEmitter` |
| `node:buffer` | ✅ Implemented | Full `Buffer` with all encodings |
| `node:url` | ✅ Implemented | WHATWG `URL` and legacy `url` |
| `node:querystring` | ✅ Implemented | `parse`, `stringify` |
| `node:zlib` | ✅ Implemented | gzip, deflate, deflate-raw via CompressionStream/DecompressionStream |
| `node:util` | ⚠️ Partial | `inspect`, `format`, `promisify`, `types` |
| `node:dns` | ❌ Not implemented | |
| `node:cluster` | ❌ Not implemented | |
| `node:worker_threads` | ❌ Not implemented | |

## Networking

DuskJS supports outbound HTTP/HTTPS and TCP via two mechanisms:

### Nova (libcurl replacement)

Nova is a Rust-based WASM module that provides `fetch`-style HTTP via a Wisp WebSocket proxy:

```ts
import * as nova from '@nightnetwork/nova';

const repl = await bootRepl(write, {
  net: {
    loadLibcurl: async () => {
      await nova.default();
      return new nova.LibCurl();
    },
    proxyUrl: 'wss://your-wisp-proxy/wisp/',
  },
});
```

### MoonBeam Relay

For TCP-level networking (e.g., `node:net` servers that accept inbound connections), provide a `RelayListener`:

```ts
const repl = await bootRepl(write, {
  net: {
    relay: myRelayListener, // implements RelayListener interface
  },
});
```

**`RelayListener` interface:**

```ts
interface RelayListener {
  registerListener(host: string, port: number, handler: (socket: RelaySocket) => void): () => void;
}

interface RelaySocket {
  onData(cb: (data: Uint8Array) => void): () => void;
  onClose(cb: (reason: number) => void): () => void;
  send(data: Uint8Array): void;
  close(reason?: number): void;
}
```

### Loopback

`node:http` servers listening on `dusk.local` (or any host registered via the socket registry) are accessible to other processes within the same runtime via loopback — no relay or proxy needed.

## File System

DuskJS provides a layered virtual filesystem:

- **TFS (Terbium File System)** — persistent storage backed by the browser's Origin Private File System (OPFS). Files written here survive page reloads.
- **Memory backend** — ephemeral in-memory FS for scratch data.
- **Layout backend** — combines both: persistent storage for `/home`, `/etc`, and user data; ephemeral storage for `/tmp`, `/proc`, and transient state.

```ts
// Persistent (default)
const repl = await bootRepl(write, { fs: 'tfs' });

// Ephemeral
const repl = await bootRepl(write, { fs: 'memory' });
```

Seed files at boot:

```ts
const repl = await bootRepl(write, {
  seed: {
    '/home/user/hello.js': 'console.log("hello");',
    '/etc/motd': 'Welcome to DuskJS',
  },
});
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                Browser Main Thread               │
│  ┌───────────────────────────────────────────┐   │
│  │            ProcessManager                 │   │
│  │  ┌─────────┐ ┌─────────┐ ┌─────────┐     │   │
│  │  │ pid 0   │ │ pid 1   │ │ pid 2   │ ... │   │
│  │  │(engine) │ │ /bin/dsh│ │/bin/node│     │   │
│  │  └────┬────┘ └────┬────┘ └────┬────┘     │   │
│  │       │           │           │           │   │
│  │       ▼           ▼           ▼           │   │
│  │  ┌─────────────────────────────────────┐  │   │
│  │  │     Native JavaScript Workers       │  │   │
│  │  │  (one Web Worker per engine)        │  │   │
│  │  └─────────────────────────────────────┘  │   │
│  └───────────────────────────────────────────┘   │
│  ┌──────────┐ ┌──────────┐ ┌─────────────────┐   │
│  │ FS Layer │ │ Net/IPC  │ │ PTY / Signals   │   │
│  │ TFS/OPFS │ │ Nova/WS  │ │ Line discipline │   │
│  └──────────┘ └──────────┘ └─────────────────┘   │
└─────────────────────────────────────────────────┘
```

- JavaScript engines run in native Web Workers by default; `spidermonkey-legacy` selects SpiderMonkey WASI workers instead
- The `ProcessManager` on the main thread orchestrates IPC, I/O routing, signal delivery, and lifecycle
- World-side shims (`node-fs.ts`, `node-net.ts`, `node-http.ts`, etc.) run inside each engine and communicate with the host via synchronous IPC (`ipc.send`)
- The engine pool pre-compiles SpiderMonkey WASI only for the legacy runtime; native workers start on demand

## Browser Requirements

- **Cross-origin-isolated context** — required for `SharedArrayBuffer` and synchronous IPC between workers and the main thread (both runtimes)
- Set these response headers on your server:
  ```
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  ```
- Modern browser with Web Workers, OPFS and the Web Locks API (both required for the persistent TFS backend), and `CompressionStream`/`DecompressionStream` (for zlib). Use `{ fs: 'memory' }` when origin-wide persistent locking is unavailable.

## Building from Source

```bash
git clone <repo-url>
cd DuskJS
npm install

npm run dev          # development server with HMR
npm run build        # full build (typecheck + vite)
npm run build:lib    # library build only (for npm publishing)
npm run typecheck    # type checking only
```

## Testing

```bash
npm test             # runs vitest in browser mode (Playwright)
```

Tests run in a real browser via `@vitest/browser-playwright` to ensure `SharedArrayBuffer` and OPFS are available.

## Contributing

Contributions are welcome. Please ensure `npm run typecheck` and `npm test` pass before submitting changes.

## License

Apache-2.0
