import { bootRepl } from '../index';
import { TRANSCRIPT_SEED } from './transcript';
import { walkOpfs, clearOpfs } from './opfs-view';
import type { LibCurl } from '../host/net';

const loadRealLibcurl = async (): Promise<LibCurl> =>
  (await import('libcurl.js/bundled')).libcurl as unknown as LibCurl;

// Example commands the user can click to try. All run inside dsh (backed by
// the vendored just-bash), which gives us grep/sed/awk/jq/find/sort/etc. plus
// a POSIX-ish shell parser with pipelines, redirects, and variables.
const SHELL_EXAMPLES: string[] = [
  // The absolute basics — should always work.
  'echo hello world',
  'ls /bin',
  'pwd',
  'whoami',
  'cat /etc/hostname',
  // Text-processing pipeline
  'printf "apple\\nbanana\\ncherry\\n" | sort',
  'printf "a\\nb\\na\\nc\\nb\\n" | sort | uniq -c',
  'echo hello world | sed s/world/dusk/',
  'echo one two three | awk "{print \\$2}"',
  // grep
  'grep root /etc/passwd',
  // JSON via jq
  'printf \'{"name":"dusk","tags":["shell","node"]}\' | jq .tags',
  // find + xargs style
  'ls /bin | head -5',
  // Filesystem round-trip
  'echo hello > /tmp/greet && cat /tmp/greet',
  // JS execution via -c
  'js-exec -c "console.log(2 + 2)"',
  // Enter node REPL (interactive) — from here the Node REPL example buttons work.
  'node',
];

// Examples for the interactive node REPL (invoked after typing `node`).
// Each line is sent as one REPL input. Variables assigned in one snippet
// persist into the next (the REPL keeps a shared context).
const NODE_EXAMPLES: string[] = [
  // Basic value evaluation
  '2 + 2',
  'Math.sqrt(144)',
  "'hello ' + 'dusk'",
  // Variable that survives across lines (bare assignment — const/let/var
  // scope to the eval frame and don't persist; see main.ts for details).
  'greeting = "hi from repl"',
  'greeting.toUpperCase()',
  // Node globals — engine-provided
  'process.version',
  "require('node:os').platform()",
  "require('node:path').join('/tmp', 'demo.txt')",
  // Async / await at top level
  'await Promise.resolve(42)',
  // Objects and arrays get pretty-printed
  '({ name: "dusk", tags: ["shell", "node"], count: 3 })',
  '[1, 2, 3].map(x => x * x)',
  // Filesystem via node stdlib — sees TFS through DuskJS's __fs bridge
  "require('node:fs').readFileSync('/etc/hostname', 'utf8')",
  // Multi-line via trailing backslash. Use assignment (persists), not
  // `function fib(...)` (would scope to the eval frame).
  'fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2)',
  'fib(10)',
  // Meta: reset context, then exit back to dsh
  '.clear',
  '.exit',
];

// sqlite3 (dsh built-in via sql.js on the host). Each entry runs as a
// standalone dsh command — sqlite3 exits after each invocation, so state
// only persists across calls if you write to a TFS path (not :memory:).
const SQLITE_EXAMPLES: string[] = [
  // Simple arithmetic
  'sqlite3 :memory: "SELECT 2 + 2"',
  // Column headers + type coercion
  'sqlite3 -header :memory: "SELECT 1 AS id, \'alice\' AS name"',
  // JSON output
  'sqlite3 -json :memory: "SELECT 42 AS x, \'y\' AS s"',
  // Create a persistent DB file in TFS
  'sqlite3 /tmp/demo.db "CREATE TABLE IF NOT EXISTS t(id INTEGER, name TEXT)"',
  'sqlite3 /tmp/demo.db "INSERT INTO t VALUES (1,\'dusk\'),(2,\'shell\')"',
  'sqlite3 -header -column /tmp/demo.db "SELECT * FROM t"',
  // Cross-tool: same DB via /bin/sqlite3 REPL (once you open it, dsh is bypassed)
  // No REPL button here — the sqlite3 command in dsh is one-shot only.
  // Aggregation
  'sqlite3 /tmp/demo.db "SELECT COUNT(*) AS n FROM t"',
  // Piped SQL via stdin
  'echo "SELECT sqlite_version()" | sqlite3 :memory:',
];

// python3 (dsh built-in via Pyodide on the host). First call downloads
// Pyodide from CDN (~10MB) and stalls for a few seconds — subsequent calls
// are fast because the interpreter is cached.
const PYTHON_EXAMPLES: string[] = [
  // Simplest
  'python3 -c "print(2 + 2)"',
  // Version
  'python3 --version',
  // sys module
  'python3 -c "import sys; print(sys.version_info)"',
  // stdlib usage
  'python3 -c "import math; print(math.pi, math.sqrt(2))"',
  // JSON + list comprehension
  'python3 -c "import json; print(json.dumps([x*x for x in range(6)]))"',
  // Read TFS-seeded file via Pyodide's node:fs bridge — wait, no: Python
  // sees Pyodide's own FS, not DuskJS TFS. Show the equivalent via -c:
  'python3 -c "print(\'\\n\'.join(str(n) for n in range(5)))"',
  // Multi-statement via inline exec
  'python3 -c "d = {\'a\':1,\'b\':2}; print(sum(d.values()))"',
  // Read a script FROM TFS: seed one with dsh, then run it
  'echo "print(\'from tfs\')" > /tmp/hi.py && python3 /tmp/hi.py',
  // Piped script
  'echo "print(\'stdin script\')" | python3',
  // python alias
  'python -c "print(\'via python alias\')"',
];

export const startPage = async (): Promise<void> => {
  const out = document.getElementById('out') as HTMLPreElement;
  const line = document.getElementById('line') as HTMLInputElement;
  const examples = document.getElementById('examples') as HTMLDivElement;
  const nodeExamples = document.getElementById('node-examples') as HTMLDivElement;
  const sqliteExamples = document.getElementById('sqlite-examples') as HTMLDivElement;
  const pythonExamples = document.getElementById('python-examples') as HTMLDivElement;
  const fsview = document.getElementById('fsview') as HTMLPreElement;
  const clearfs = document.getElementById('clearfs') as HTMLButtonElement;

  const write = (text: string): void => {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  };

  const refreshFsView = async (): Promise<void> => {
    try { fsview.textContent = await walkOpfs(); }
    catch (e) { fsview.textContent = 'error reading OPFS: ' + String(e); }
  };

  if (!crossOriginIsolated) { write('error: not cross-origin isolated (SharedArrayBuffer unavailable)\n'); return; }

  write('booting DuskJS...\n');
  const repl = await bootRepl(write, {
    net: { loadLibcurl: loadRealLibcurl, proxyUrl: 'wss://gointospace.app/wisp/' },
    seed: TRANSCRIPT_SEED,
  });
  write('spawning /bin/dsh (interactive)...\n');
  const sh = await repl.processManager.spawn('/bin/dsh', [], {
    cwd: '/root',
    env: { HOME: '/root', PATH: '/usr/local/bin:/usr/bin:/bin', TERM: 'xterm-256color', USER: 'dusk' },
    pty: { cols: 80, rows: 24 },
  });

  // With a PTY attached, master's onMasterData already carries BOTH the
  // process's stdout/stderr (via slaveWrite) AND the line-discipline echo of
  // typed input. Don't also pump sh.stdout/sh.stderr — that would double
  // every character. See host/pty.ts:129 and host/process-manager.ts:632.
  const masterDecoder = new TextDecoder();
  sh.master?.onMasterData((bytes) => {
    if (bytes.length) write(masterDecoder.decode(bytes, { stream: true }));
  });
  // Drain the byte streams so they don't backpressure, but discard their
  // output — the terminal render happens exclusively through onMasterData.
  const drain = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const reader = stream.getReader();
    try { while (true) { const { done } = await reader.read(); if (done) break; } }
    catch { /* stream closed */ }
  };
  void drain(sh.stdout);
  void drain(sh.stderr);

  void sh.exit.then((code) => write('\n[shell exited with code ' + String(code) + ']\n'));

  write('ready. (fs is persistent via TFS/OPFS)\n');
  await refreshFsView();

  const encoder = new TextEncoder();
  const submit = async (text: string): Promise<void> => {
    await sh.stdin.write(encoder.encode(text + '\n'));
    await refreshFsView();
  };

  line.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Enter') return;
    const text = line.value;
    line.value = '';
    void submit(text);
  });

  clearfs.addEventListener('click', () => {
    void (async () => {
      try { await clearOpfs(); } catch (e) { write('clear fs error: ' + String(e) + '\n'); }
      await refreshFsView();
    })();
  });

  for (const ex of SHELL_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    btn.addEventListener('click', () => { void submit(ex); });
    examples.appendChild(btn);
  }
  for (const ex of NODE_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    // Node REPL examples go to the same stdin — the shell forwards them to
    // whichever mode is active. If the user hasn't run `node` first, these
    // will be interpreted as shell commands and mostly fail; that's fine
    // and the label above the section explains the ordering.
    btn.addEventListener('click', () => { void submit(ex); });
    nodeExamples.appendChild(btn);
  }
  for (const ex of SQLITE_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    btn.addEventListener('click', () => { void submit(ex); });
    sqliteExamples.appendChild(btn);
  }
  for (const ex of PYTHON_EXAMPLES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    btn.addEventListener('click', () => { void submit(ex); });
    pythonExamples.appendChild(btn);
  }
};
