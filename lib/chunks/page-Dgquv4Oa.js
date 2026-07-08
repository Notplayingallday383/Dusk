import { bootRepl } from "../duskjs.js";
import { a as TRANSCRIPT_SEED } from "./transcript-mXMTOQd9.js";
const getRoot = async () => await navigator.storage.getDirectory();
const walkDir = async (dir, prefix) => {
  const entries = [];
  for await (const entry of dir.entries()) entries.push(entry);
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [];
  for (const [name, handle] of entries) {
    if (handle.kind === "directory") {
      lines.push(prefix + name + "/");
      lines.push(...await walkDir(handle, prefix + "  "));
    } else {
      lines.push(prefix + name);
    }
  }
  return lines;
};
const walkOpfs = async () => {
  const root = await getRoot();
  const lines = await walkDir(root, "");
  return lines.length > 0 ? lines.join("\n") : "(empty)";
};
const clearOpfs = async () => {
  const root = await getRoot();
  const names = [];
  for await (const [name] of root.entries()) names.push(name);
  for (const name of names) await root.removeEntry(name, { recursive: true });
};
const loadRealLibcurl = async () => {
  const nova = await import("./nova_wasm-B9xXc0_e.js");
  await nova.default();
  return new nova.LibCurl();
};
const SHELL_EXAMPLES = [
  // The absolute basics — should always work.
  "echo hello world",
  "ls /bin",
  "pwd",
  "whoami",
  "cat /etc/hostname",
  // Text-processing pipeline
  'printf "apple\\nbanana\\ncherry\\n" | sort',
  'printf "a\\nb\\na\\nc\\nb\\n" | sort | uniq -c',
  "echo hello world | sed s/world/dusk/",
  'echo one two three | awk "{print \\$2}"',
  // grep
  "grep root /etc/passwd",
  // JSON via jq
  `printf '{"name":"dusk","tags":["shell","node"]}' | jq .tags`,
  // find + xargs style
  "ls /bin | head -5",
  // Filesystem round-trip
  "echo hello > /tmp/greet && cat /tmp/greet",
  // JS execution via -c
  'js-exec -c "console.log(2 + 2)"',
  // Enter node REPL (interactive) — from here the Node REPL example buttons work.
  "node"
];
const NODE_EXAMPLES = [
  // Basic value evaluation
  "2 + 2",
  "Math.sqrt(144)",
  "'hello ' + 'dusk'",
  // Variable that survives across lines (bare assignment — const/let/var
  // scope to the eval frame and don't persist; see main.ts for details).
  'greeting = "hi from repl"',
  "greeting.toUpperCase()",
  // Node globals — engine-provided
  "process.version",
  "require('node:os').platform()",
  "require('node:path').join('/tmp', 'demo.txt')",
  // Async / await at top level
  "await Promise.resolve(42)",
  // Objects and arrays get pretty-printed
  '({ name: "dusk", tags: ["shell", "node"], count: 3 })',
  "[1, 2, 3].map(x => x * x)",
  // Filesystem via node stdlib — sees TFS through DuskJS's __fs bridge
  "require('node:fs').readFileSync('/etc/hostname', 'utf8')",
  // Multi-line via trailing backslash. Use assignment (persists), not
  // `function fib(...)` (would scope to the eval frame).
  "fib = (n) => n < 2 ? n : fib(n - 1) + fib(n - 2)",
  "fib(10)",
  // Meta: reset context, then exit back to dsh
  ".clear",
  ".exit"
];
const SQLITE_EXAMPLES = [
  // Simple arithmetic
  'sqlite3 :memory: "SELECT 2 + 2"',
  // Column headers + type coercion
  `sqlite3 -header :memory: "SELECT 1 AS id, 'alice' AS name"`,
  // JSON output
  `sqlite3 -json :memory: "SELECT 42 AS x, 'y' AS s"`,
  // Create a persistent DB file in TFS
  'sqlite3 /tmp/demo.db "CREATE TABLE IF NOT EXISTS t(id INTEGER, name TEXT)"',
  `sqlite3 /tmp/demo.db "INSERT INTO t VALUES (1,'dusk'),(2,'shell')"`,
  'sqlite3 -header -column /tmp/demo.db "SELECT * FROM t"',
  // Cross-tool: same DB via /bin/sqlite3 REPL (once you open it, dsh is bypassed)
  // No REPL button here — the sqlite3 command in dsh is one-shot only.
  // Aggregation
  'sqlite3 /tmp/demo.db "SELECT COUNT(*) AS n FROM t"',
  // Piped SQL via stdin
  'echo "SELECT sqlite_version()" | sqlite3 :memory:'
];
const CRYPTO_EXAMPLES = [
  // ─── Randomness ────────────────────────────────────────────────
  "require('crypto').randomBytes(16).toString('hex')",
  "require('crypto').randomUUID()",
  "require('crypto').randomInt(1, 100)",
  "c = require('crypto'); Array.from({length: 5}, () => c.randomInt(0, 10))",
  // ─── Hashing ───────────────────────────────────────────────────
  "require('crypto').createHash('md5').update('hello').digest('hex')",
  "require('crypto').createHash('sha1').update('hello world').digest('hex')",
  "require('crypto').createHash('sha256').update('the quick brown fox').digest('hex')",
  "require('crypto').createHash('sha512').update('duskjs').digest('base64')",
  "h = require('crypto').createHash('sha256'); h.update('one'); h.update('two'); h.update('three'); h.digest('hex')",
  "c = require('crypto'); s = 'password123'; ({md5: c.createHash('md5').update(s).digest('hex'), sha1: c.createHash('sha1').update(s).digest('hex'), sha256: c.createHash('sha256').update(s).digest('hex')})",
  // ─── HMAC ──────────────────────────────────────────────────────
  "require('crypto').createHmac('sha256', 'secret-key').update('message').digest('hex')",
  "require('crypto').createHmac('sha512', 'k').update('m').digest('base64')",
  "c = require('crypto'); key = 'shhh'; msg = 'attack at dawn'; sig1 = c.createHmac('sha256', key).update(msg).digest('hex'); check = c.createHmac('sha256', key).update(msg).digest('hex'); ({sig1, check, ok: sig1 === check})",
  // ─── Timing-safe compare ───────────────────────────────────────
  "c = require('crypto'); c.timingSafeEqual(Buffer.from('secret'), Buffer.from('secret'))",
  "c = require('crypto'); c.timingSafeEqual(Buffer.from('abc'), Buffer.from('abd'))",
  // ─── PBKDF2 (host IPC) ─────────────────────────────────────────
  "require('crypto').pbkdf2Sync('mypassword', 'salt', 1000, 32, 'sha256').toString('hex')",
  "require('crypto').pbkdf2('pw', 'salt-value', 10000, 64, 'sha512', (e, k) => console.log(k.toString('hex')))",
  "require('crypto').pbkdf2Sync('correct horse battery staple', 'unique-salt', 100000, 32, 'sha256').toString('hex')",
  // ─── AES-256-CBC round-trip ────────────────────────────────────
  "c = require('crypto'); cbcKey = c.randomBytes(32); cbcIv = c.randomBytes(16); cbcCipher = c.createCipheriv('aes-256-cbc', cbcKey, cbcIv); cbcEnc = Buffer.concat([cbcCipher.update('hello world', 'utf8'), cbcCipher.final()]); cbcDec = c.createDecipheriv('aes-256-cbc', cbcKey, cbcIv); cbcOut = Buffer.concat([cbcDec.update(cbcEnc), cbcDec.final()]).toString('utf8'); ({encHex: cbcEnc.toString('hex'), plain: cbcOut})",
  // ─── AES-128-CTR round-trip ────────────────────────────────────
  "c = require('crypto'); ctrKey = c.randomBytes(16); ctrIv = c.randomBytes(16); ctrE = c.createCipheriv('aes-128-ctr', ctrKey, ctrIv); ctrCt = Buffer.concat([ctrE.update('streaming data'), ctrE.final()]); ctrD = c.createDecipheriv('aes-128-ctr', ctrKey, ctrIv); Buffer.concat([ctrD.update(ctrCt), ctrD.final()]).toString()",
  // ─── AES-256-GCM (authenticated) ───────────────────────────────
  "c = require('crypto'); gcmKey = c.randomBytes(32); gcmIv = c.randomBytes(12); gcmCipher = c.createCipheriv('aes-256-gcm', gcmKey, gcmIv); gcmCt = Buffer.concat([gcmCipher.update('sensitive'), gcmCipher.final()]); gcmTag = gcmCipher.getAuthTag(); gcmDec = c.createDecipheriv('aes-256-gcm', gcmKey, gcmIv); gcmDec.setAuthTag(gcmTag); Buffer.concat([gcmDec.update(gcmCt), gcmDec.final()]).toString()",
  // ─── RSA-2048 keypair + sign/verify (real WebCrypto — ~2-5s) ───
  "kp = require('crypto').generateKeyPairSync('rsa', {modulusLength: 2048, publicKeyEncoding: {type:'spki',format:'pem'}, privateKeyEncoding: {type:'pkcs8',format:'pem'}}); kp.publicKey.slice(0, 80)",
  "rsaSig = require('crypto').createSign('sha256').update('important message').sign(kp.privateKey); rsaSig.toString('base64').slice(0, 60) + '...'",
  "require('crypto').createVerify('sha256').update('important message').verify(kp.publicKey, rsaSig)",
  "require('crypto').createVerify('sha256').update('important message TAMPERED').verify(kp.publicKey, rsaSig)",
  // ─── EC P-256 keypair + ECDSA sign/verify ──────────────────────
  "ec = require('crypto').generateKeyPairSync('ec', {namedCurve: 'P-256', publicKeyEncoding: {type:'spki',format:'pem'}, privateKeyEncoding: {type:'pkcs8',format:'pem'}}); ec.publicKey.slice(0, 80)",
  "ecSig = require('crypto').createSign('sha256').update('signed with EC').sign(ec.privateKey); require('crypto').createVerify('sha256').update('signed with EC').verify(ec.publicKey, ecSig)",
  // ─── Discovery ─────────────────────────────────────────────────
  "require('crypto').getHashes()",
  "require('crypto').getCiphers()",
  // ─── WebCrypto passthrough ─────────────────────────────────────
  "w = require('crypto').webcrypto; w.getRandomValues(new Uint8Array(8))",
  "w = require('crypto').webcrypto; wcBuf = await w.subtle.digest('SHA-256', new TextEncoder().encode('hi')); Buffer.from(wcBuf).toString('hex')",
  // ─── Encrypted vault (2-step; click in order) ──────────────────
  // Step 1: encrypt into `stored`
  "c = require('crypto'); vPw = 'user-master-password'; vSalt = c.randomBytes(16); vIv = c.randomBytes(12); vKey = c.pbkdf2Sync(vPw, vSalt, 100000, 32, 'sha256'); vCipher = c.createCipheriv('aes-256-gcm', vKey, vIv); vCt = Buffer.concat([vCipher.update('my-github-token-abc123', 'utf8'), vCipher.final()]); vTag = vCipher.getAuthTag(); stored = { salt: vSalt.toString('base64'), iv: vIv.toString('base64'), ct: vCt.toString('base64'), tag: vTag.toString('base64') }; stored",
  // Step 2: decrypt using the `stored` bundle from step 1
  "c = require('crypto'); dSalt = Buffer.from(stored.salt, 'base64'); dIv = Buffer.from(stored.iv, 'base64'); dTag = Buffer.from(stored.tag, 'base64'); dKey = c.pbkdf2Sync('user-master-password', dSalt, 100000, 32, 'sha256'); dDec = c.createDecipheriv('aes-256-gcm', dKey, dIv); dDec.setAuthTag(dTag); Buffer.concat([dDec.update(Buffer.from(stored.ct, 'base64')), dDec.final()]).toString('utf8')"
];
const PYTHON_EXAMPLES = [
  // Simplest
  'python3 -c "print(2 + 2)"',
  // Version
  "python3 --version",
  // sys module
  'python3 -c "import sys; print(sys.version_info)"',
  // stdlib usage
  'python3 -c "import math; print(math.pi, math.sqrt(2))"',
  // JSON + list comprehension
  'python3 -c "import json; print(json.dumps([x*x for x in range(6)]))"',
  // Read TFS-seeded file via Pyodide's node:fs bridge — wait, no: Python
  // sees Pyodide's own FS, not DuskJS TFS. Show the equivalent via -c:
  `python3 -c "print('\\n'.join(str(n) for n in range(5)))"`,
  // Multi-statement via inline exec
  `python3 -c "d = {'a':1,'b':2}; print(sum(d.values()))"`,
  // Read a script FROM TFS: seed one with dsh, then run it
  `echo "print('from tfs')" > /tmp/hi.py && python3 /tmp/hi.py`,
  // Piped script
  `echo "print('stdin script')" | python3`,
  // python alias
  `python -c "print('via python alias')"`
];
const startPage = async () => {
  var _a;
  const out = document.getElementById("out");
  const line = document.getElementById("line");
  const examples = document.getElementById("examples");
  const nodeExamples = document.getElementById("node-examples");
  const cryptoExamples = document.getElementById("crypto-examples");
  const sqliteExamples = document.getElementById("sqlite-examples");
  const pythonExamples = document.getElementById("python-examples");
  const fsview = document.getElementById("fsview");
  const clearfs = document.getElementById("clearfs");
  const write = (text) => {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  };
  const refreshFsView = async () => {
    try {
      fsview.textContent = await walkOpfs();
    } catch (e) {
      fsview.textContent = "error reading OPFS: " + String(e);
    }
  };
  if (!crossOriginIsolated) {
    write("error: not cross-origin isolated (SharedArrayBuffer unavailable)\n");
    return;
  }
  write("booting DuskJS...\n");
  const repl = await bootRepl(write, {
    net: { loadLibcurl: loadRealLibcurl, proxyUrl: "wss://gointospace.app/wisp/" },
    seed: TRANSCRIPT_SEED,
    // The demo drives dsh directly via stdin (no `feed()` calls), so the
    // pid-0 engine that bootRepl would otherwise create is dead weight —
    // it's a whole SpiderMonkey Worker (~100MB) that just sits idle.
    // Skipping it roughly halves the demo's steady-state memory footprint.
    skipPidZero: true
  });
  write("spawning /bin/dsh (interactive)...\n");
  const sh = await repl.processManager.spawn("/bin/dsh", [], {
    cwd: "/root",
    env: { HOME: "/root", PATH: "/usr/local/bin:/usr/bin:/bin", TERM: "xterm-256color", USER: "dusk" },
    pty: { cols: 80, rows: 24 }
  });
  const masterDecoder = new TextDecoder();
  (_a = sh.master) == null ? void 0 : _a.onMasterData((bytes) => {
    if (bytes.length) write(masterDecoder.decode(bytes, { stream: true }));
  });
  const drain = async (stream) => {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    } catch {
    }
  };
  void drain(sh.stdout);
  void drain(sh.stderr);
  void sh.exit.then((code) => write("\n[shell exited with code " + String(code) + "]\n"));
  write("ready. (fs is persistent via TFS/OPFS)\n");
  await refreshFsView();
  const encoder = new TextEncoder();
  const submit = async (text) => {
    await sh.stdin.write(encoder.encode(text + "\n"));
    await refreshFsView();
  };
  line.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const text = line.value;
    line.value = "";
    void submit(text);
  });
  clearfs.addEventListener("click", () => {
    void (async () => {
      try {
        await clearOpfs();
      } catch (e) {
        write("clear fs error: " + String(e) + "\n");
      }
      await refreshFsView();
    })();
  });
  for (const ex of SHELL_EXAMPLES) {
    const btn = document.createElement("button");
    btn.textContent = ex;
    btn.addEventListener("click", () => {
      void submit(ex);
    });
    examples.appendChild(btn);
  }
  for (const ex of NODE_EXAMPLES) {
    const btn = document.createElement("button");
    btn.textContent = ex;
    btn.addEventListener("click", () => {
      void submit(ex);
    });
    nodeExamples.appendChild(btn);
  }
  for (const ex of CRYPTO_EXAMPLES) {
    const btn = document.createElement("button");
    btn.textContent = ex.length > 72 ? ex.slice(0, 69) + "..." : ex;
    btn.title = ex;
    btn.addEventListener("click", () => {
      void submit(ex);
    });
    cryptoExamples.appendChild(btn);
  }
  for (const ex of SQLITE_EXAMPLES) {
    const btn = document.createElement("button");
    btn.textContent = ex;
    btn.addEventListener("click", () => {
      void submit(ex);
    });
    sqliteExamples.appendChild(btn);
  }
  for (const ex of PYTHON_EXAMPLES) {
    const btn = document.createElement("button");
    btn.textContent = ex;
    btn.addEventListener("click", () => {
      void submit(ex);
    });
    pythonExamples.appendChild(btn);
  }
};
export {
  startPage
};
//# sourceMappingURL=page-Dgquv4Oa.js.map
