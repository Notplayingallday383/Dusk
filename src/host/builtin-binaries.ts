export const BUILTIN_BINARIES: Record<string, string> = {
  '/bin/true': '',
  '/bin/false': 'process.exit(1);',
  '/bin/echo': "(function(){ var args = process.argv.slice(1); var i = 0; var newline = true; if (args[0] === '-n') { newline = false; i = 1; } var msg = args.slice(i).join(' '); if (newline) msg += '\\n'; process.stdout.write(msg); })();",
  '/bin/pwd': 'process.stdout.write(process.cwd() + "\\n");',
  '/bin/cat': "(function(){ var files = process.argv.slice(1); if (files.length === 0) { while (true) { var r = ipc.send({ f: 'proc.readStdin' }); if (r.value === null) break; if (r.value && r.value.length) process.stdout.write(new Uint8Array(r.value)); else { var deadline = Date.now() + 10; while (Date.now() < deadline) {} } } } else { for (var i = 0; i < files.length; i++) { try { process.stdout.write(__fs.readFile(files[i])); } catch (e) { process.stderr.write('cat: ' + files[i] + ': ' + e + '\\n'); process.exit(1); } } } })();",
  '/bin/env': "(function(){ var keys = Object.keys(process.env); for (var i = 0; i < keys.length; i++) process.stdout.write(keys[i] + '=' + process.env[keys[i]] + '\\n'); })();",
  // ls: minimal — accepts flags -l -a (mostly ignored), and one or more paths (defaults to cwd).
  // Prints one entry per line. -l uses the same 1/entry format (no columns yet).
  // -a shows dotfiles. Errors go to stderr with exit 1 on any bad path.
  '/bin/ls': "(function(){ var args = process.argv.slice(1); var showHidden = false; var paths = []; for (var i = 0; i < args.length; i++) { var a = args[i]; if (a === '-a' || a === '-la' || a === '-al') showHidden = true; else if (a && a.charAt(0) === '-') { /* other flags ignored for now */ } else paths.push(a); } if (paths.length === 0) paths = [process.cwd()]; var bad = false; for (var j = 0; j < paths.length; j++) { var p = paths[j]; try { var entries = __fs.readdir(p); if (paths.length > 1) process.stdout.write(p + ':\\n'); for (var k = 0; k < entries.length; k++) { var name = entries[k]; if (!showHidden && name && name.charAt(0) === '.') continue; process.stdout.write(name + '\\n'); } if (paths.length > 1 && j < paths.length - 1) process.stdout.write('\\n'); } catch (e) { process.stderr.write('ls: ' + p + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // mkdir: creates directory. -p makes parents.
  '/bin/mkdir': "(function(){ var args = process.argv.slice(1); var recursive = false; var paths = []; for (var i = 0; i < args.length; i++) { var a = args[i]; if (a === '-p') recursive = true; else if (a && a.charAt(0) === '-') { /* ignore */ } else paths.push(a); } if (paths.length === 0) { process.stderr.write('mkdir: missing operand\\n'); process.exit(1); } var bad = false; for (var j = 0; j < paths.length; j++) { try { __fs.mkdir(paths[j], recursive); } catch (e) { process.stderr.write('mkdir: ' + paths[j] + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // rm: deletes file or directory. -r/-rf recursive.
  '/bin/rm': "(function(){ var args = process.argv.slice(1); var paths = []; for (var i = 0; i < args.length; i++) { var a = args[i]; if (a && a.charAt(0) === '-') { /* flags ignored — always attempts rm */ } else paths.push(a); } if (paths.length === 0) { process.stderr.write('rm: missing operand\\n'); process.exit(1); } var bad = false; for (var j = 0; j < paths.length; j++) { try { __fs.rm(paths[j]); } catch (e) { process.stderr.write('rm: ' + paths[j] + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // touch: creates empty file if missing (existing files get their content preserved).
  '/bin/touch': "(function(){ var args = process.argv.slice(1); if (args.length === 0) { process.stderr.write('touch: missing operand\\n'); process.exit(1); } var bad = false; for (var i = 0; i < args.length; i++) { try { if (!__fs.exists(args[i])) __fs.writeFile(args[i], ''); } catch (e) { process.stderr.write('touch: ' + args[i] + ': ' + e + '\\n'); bad = true; } } if (bad) process.exit(1); })();",
  // whoami: print USER env, defaulting to 'dusk'.
  '/bin/whoami': "process.stdout.write((process.env.USER || 'dusk') + '\\n');",
  // hostname: print /etc/hostname content or 'duskjs'.
  '/bin/hostname': "(function(){ try { var h = __fs.readFile('/etc/hostname'); process.stdout.write(h.replace(/\\n+$/, '') + '\\n'); } catch (e) { process.stdout.write('duskjs\\n'); } })();",
  // clear: emit ANSI clear-screen (works on real terminals; harmless in <pre>).
  '/bin/clear': 'process.stdout.write("\\x1b[2J\\x1b[H");',
  // curl: minimal HTTP client backed by globalThis.fetch (which world/net.ts
  // installs and routes through Nova). Supports: -X METHOD, -H 'K: V',
  // -d BODY (implies -X POST), -o FILE, -s (silent — omit progress lines),
  // -i (include response headers in output), -L (follow redirects; default),
  // -v (verbose to stderr), --url URL, and bare positional URL.
  '/bin/curl': "#!/bin/node\n(async function(){\n" +
    "  // When routed through /bin/node, process.argv = ['node', scriptPath, ...userArgs].\n" +
    "  // slice(2) skips both to get only the user args.\n" +
    "  var argv = process.argv.slice(2);\n" +
    "  if (argv.length === 0) { process.stderr.write('curl: try \\'curl --help\\' for more information\\n'); process.exit(2); }\n" +
    "  if (argv[0] === '--help' || argv[0] === '-h') {\n" +
    "    process.stdout.write('Usage: curl [options] <url>\\n  -X, --request METHOD    HTTP method (default GET)\\n  -H, --header \\'K: V\\'   Add request header (repeatable)\\n  -d, --data BODY         Request body (sets method to POST unless -X used)\\n  -o FILE                 Write body to FILE instead of stdout\\n  -s, --silent            Silent mode\\n  -i, --include           Include response headers in output\\n  -v, --verbose           Verbose logging to stderr\\n  --url URL               Explicit URL flag\\n');\n" +
    "    return;\n" +
    "  }\n" +
    "  var url = null; var method = null; var headers = {}; var body = null;\n" +
    "  var outFile = null; var silent = false; var include = false; var verbose = false;\n" +
    "  for (var i = 0; i < argv.length; i++) {\n" +
    "    var a = argv[i];\n" +
    "    if (a === '-X' || a === '--request') { method = argv[++i]; }\n" +
    "    else if (a === '-H' || a === '--header') {\n" +
    "      var h = argv[++i] || ''; var idx = h.indexOf(':');\n" +
    "      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();\n" +
    "    }\n" +
    "    else if (a === '-d' || a === '--data' || a === '--data-raw') { body = argv[++i]; if (!method) method = 'POST'; }\n" +
    "    else if (a === '-o' || a === '--output') { outFile = argv[++i]; }\n" +
    "    else if (a === '-s' || a === '--silent') { silent = true; }\n" +
    "    else if (a === '-i' || a === '--include') { include = true; }\n" +
    "    else if (a === '-v' || a === '--verbose') { verbose = true; }\n" +
    "    else if (a === '-L' || a === '--location') { /* default */ }\n" +
    "    else if (a === '--url') { url = argv[++i]; }\n" +
    "    else if (a && a.charAt(0) !== '-') { url = a; }\n" +
    "    else if (a && a.charAt(0) === '-') { /* ignore unknown flags */ }\n" +
    "  }\n" +
    "  if (!url) { process.stderr.write('curl: no URL specified\\n'); process.exit(2); }\n" +
    "  if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;\n" +
    "  if (verbose) process.stderr.write('* ' + (method || 'GET') + ' ' + url + '\\n');\n" +
    "  try {\n" +
    "    var opts = { method: method || 'GET', headers: headers };\n" +
    "    if (body != null) opts.body = body;\n" +
    "    var res = await fetch(url, opts);\n" +
    "    if (verbose || include) {\n" +
    "      var statusLine = 'HTTP/1.1 ' + res.status + ' ' + (res.statusText || '');\n" +
    "      if (verbose) process.stderr.write('< ' + statusLine + '\\n');\n" +
    "      if (include) process.stdout.write(statusLine + '\\n');\n" +
    "      if (res.headers && typeof res.headers.forEach === 'function') {\n" +
    "        res.headers.forEach(function(v, k) {\n" +
    "          var line = k + ': ' + v;\n" +
    "          if (verbose) process.stderr.write('< ' + line + '\\n');\n" +
    "          if (include) process.stdout.write(line + '\\n');\n" +
    "        });\n" +
    "      }\n" +
    "      if (include) process.stdout.write('\\n');\n" +
    "    }\n" +
    "    var text = await res.text();\n" +
    "    if (outFile) { __fs.writeFile(outFile, text); if (!silent) process.stderr.write('curl: wrote ' + text.length + ' bytes to ' + outFile + '\\n'); }\n" +
    "    else { process.stdout.write(text); }\n" +
    "    if (!res.ok && !include && !silent) process.stderr.write('curl: HTTP ' + res.status + ' ' + (res.statusText || '') + '\\n');\n" +
    "    process.exit(res.ok ? 0 : (res.status >= 400 ? 22 : 0));\n" +
    "  } catch (e) {\n" +
    "    process.stderr.write('curl: (' + ((e && e.name) || 'Error') + ') ' + ((e && e.message) || String(e)) + '\\n');\n" +
    "    process.exit(6);\n" +
    "  }\n" +
    "})();",
  // wget: minimal alias — behaves like `curl -sL -o <file>` when given -O,
  // else writes body to a filename derived from the URL path. Supports:
  // -O FILE (explicit output), -q (quiet), and positional URL.
  '/bin/wget': "#!/bin/node\n(async function(){\n" +
    "  // slice(2) skips ['node', scriptPath] — same as curl.\n" +
    "  var argv = process.argv.slice(2);\n" +
    "  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {\n" +
    "    process.stdout.write('Usage: wget [-q] [-O FILE] <url>\\n'); process.exit(argv.length === 0 ? 1 : 0);\n" +
    "  }\n" +
    "  var url = null; var outFile = null; var quiet = false;\n" +
    "  for (var i = 0; i < argv.length; i++) {\n" +
    "    var a = argv[i];\n" +
    "    if (a === '-O' || a === '--output-document') outFile = argv[++i];\n" +
    "    else if (a === '-q' || a === '--quiet') quiet = true;\n" +
    "    else if (a && a.charAt(0) !== '-') url = a;\n" +
    "  }\n" +
    "  if (!url) { process.stderr.write('wget: missing URL\\n'); process.exit(1); }\n" +
    "  if (!/^https?:\\/\\//i.test(url)) url = 'https://' + url;\n" +
    "  if (!outFile) {\n" +
    "    var m = /\\/([^\\/?#]+)(?:[?#]|$)/.exec(url);\n" +
    "    outFile = (m && m[1]) ? m[1] : 'index.html';\n" +
    "  }\n" +
    "  try {\n" +
    "    var res = await fetch(url);\n" +
    "    var text = await res.text();\n" +
    "    __fs.writeFile(outFile, text);\n" +
    "    if (!quiet) process.stderr.write(\"'\" + outFile + \"' saved [\" + text.length + \" bytes]\\n\");\n" +
    "    process.exit(res.ok ? 0 : 8);\n" +
    "  } catch (e) {\n" +
    "    process.stderr.write('wget: ' + ((e && e.message) || String(e)) + '\\n');\n" +
    "    process.exit(4);\n" +
    "  }\n" +
    "})();",
};

// Just-bash commands: thin wrappers that shell out to /bin/dsh so users can
// invoke `grep`, `sed`, `awk`, etc. directly at a shell prompt without the
// `dsh -c "..."` incantation.
//
// Two dispatch paths exist:
//
//   1. Elision (fast path): the ProcessManager checks JSH_COMMAND_SET before
//      spawning and, if the command is in the set, rewrites the spawn to
//      `/bin/dsh -c '<name> <args>'` directly. This saves a whole
//      SpiderMonkey Worker (~100MB) per invocation by avoiding the
//      intermediate JSH-wrapper process. See process-manager.ts spawn().
//
//   2. Fallback wrapper (slow path): if the elision was bypassed for any
//      reason and /bin/grep etc. are actually spawned, this in-engine
//      wrapper reads stdin then spawnSync('/bin/dsh', ['-c', script])s
//      inside its own worker. Kept as a safety net; every current call
//      site goes through the fast path.
export const JSH_COMMANDS = [
  // Text processing
  'grep', 'egrep', 'fgrep', 'rg', 'sed', 'awk', 'sort', 'uniq', 'cut', 'paste',
  'tac', 'tr', 'tee', 'fold', 'expand', 'nl', 'rev', 'od',
  'strings', 'column', 'comm', 'diff', 'join', 'split',
  // File/directory ops
  'cp', 'mv', 'find', 'xargs', 'chmod', 'ln', 'du', 'stat', 'readlink', 'rmdir',
  // Data formats / hashing
  'jq', 'yq', 'base64', 'md5sum', 'printf', 'expr', 'date', 'file', 'which', 'tree',
  // JS execution (routes to /bin/node inside dsh)
  'js-exec', 'js',
  // Utils
  'head', 'tail', 'wc', 'seq', 'sleep', 'basename', 'dirname', 'timeout',
];

// The wrapper source: read argv (excluding argv[0]), quote each arg for shell,
// then invoke `/bin/dsh -c 'name arg1 arg2 ...'`. Forward stdin bytes as
// process.stdin content so pipelines work.
const buildJshWrapper = (cmdName: string): string => {
  return "(function(){\n"
    + "  var argv = (process.argv || []).slice(1);\n"
    + "  var qArgs = argv.map(function(a){ return \"'\" + String(a).replace(/'/g, \"'\\\\''\") + \"'\"; });\n"
    + "  var script = " + JSON.stringify(cmdName) + " + (qArgs.length ? ' ' + qArgs.join(' ') : '');\n"
    + "  // Read all of stdin. Loop until we see a null (EOF) response from\n"
    + "  // the host, OR we see two consecutive empty-array responses (no more\n"
    + "  // data buffered and stdin isn't closing on its own). Track empties\n"
    + "  // instead of a Date.now() spin, which is unreliable under the fake\n"
    + "  // engine timer.\n"
    + "  var stdinBytes = [];\n"
    + "  var emptyStreak = 0;\n"
    + "  while (emptyStreak < 2) {\n"
    + "    var r = ipc.send({ f: 'proc.readStdin' });\n"
    + "    if (!r || r.value === null) break;\n"
    + "    if (r.value && r.value.length > 0) {\n"
    + "      for (var i = 0; i < r.value.length; i++) stdinBytes.push(r.value[i]);\n"
    + "      emptyStreak = 0;\n"
    + "    } else {\n"
    + "      emptyStreak++;\n"
    + "    }\n"
    + "  }\n"
    + "  var cp = require('node:child_process');\n"
    + "  var opts = { cwd: process.cwd() };\n"
    + "  if (stdinBytes.length > 0) opts.stdin = new Uint8Array(stdinBytes);\n"
    + "  var r = cp.spawnSync('/bin/dsh', ['-c', script], opts);\n"
    + "  if (r.stdout && r.stdout.length) process.stdout.write(r.stdout);\n"
    + "  if (r.stderr && r.stderr.length) process.stderr.write(r.stderr);\n"
    + "  process.exit(r.status || 0);\n"
    + "})();";
};

// Fast-path set: names in this set get their /bin/<name> spawn rewritten
// to /bin/dsh -c '<name> ...' by ProcessManager. Excludes any name that
// happens to also be a native builtin (checked below).
export const JSH_COMMAND_SET: Set<string> = new Set(
  JSH_COMMANDS
    .map((n) => '/bin/' + n)
    .filter((k) => !Object.prototype.hasOwnProperty.call(BUILTIN_BINARIES, k)),
);

for (const name of JSH_COMMANDS) {
  const key = '/bin/' + name;
  // Don't overwrite in-engine builtins registered above. If we already have
  // a fast native implementation for this command, keep it.
  if (Object.prototype.hasOwnProperty.call(BUILTIN_BINARIES, key)) continue;
  BUILTIN_BINARIES[key] = buildJshWrapper(name);
}
