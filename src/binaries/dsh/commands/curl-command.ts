// @ts-nocheck
import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const bytesToLatin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (let i = 0; i < bytes.length; i++) text += String.fromCharCode(bytes[i]!);
  return text;
};

const concat = (first: Uint8Array, second: Uint8Array): Uint8Array => {
  const output = new Uint8Array(first.length + second.length);
  output.set(first);
  output.set(second, first.length);
  return output;
};

const transportCategory = (detail: string): string => {
  const lower = detail.toLowerCase();
  if (lower.includes('dns') || lower.includes('getaddrinfo') || lower.includes('enotfound')) return 'DNS';
  if (lower.includes('timeout') || lower.includes('timed out')) return 'timeout';
  if (lower.includes('tls') || lower.includes('ssl') || lower.includes('certificate')) return 'TLS';
  if (lower.includes('connect') || lower.includes('refused') || lower.includes('econn')) return 'connect';
  if (lower.includes('unavailable') || lower.includes('not supported')) return 'unavailable';
  return 'transport';
};

export const curlCommand: Command = {
  name: 'curl',
  trusted: true,
  async execute(argv: string[], _ctx: CommandContext): Promise<ExecResult> {
    if (argv.length === 0) return { stdout: '', stderr: "curl: try 'curl --help' for more information\n", exitCode: 2 };
    if (argv.length === 1 && (argv[0] === '--help' || argv[0] === '-h')) {
      return { stdout: 'Usage: curl [options] <url>\n  -X, --request METHOD    HTTP method (default GET)\n  -H, --header \'K: V\'   Add request header (repeatable)\n  -d, --data BODY         Request body (sets method to POST unless -X used)\n  -o, --output FILE       Write output to FILE instead of stdout\n  -s, --silent            Suppress informational diagnostics\n  -i, --include           Include response headers in output\n  -L, --location          Follow redirects (off by default)\n  -v, --verbose           Verbose logging to stderr\n  --url URL               Explicit URL flag\n', stderr: '', exitCode: 0 };
    }

    let url: string | null = null;
    let method: string | null = null;
    const headers: Record<string, string> = {};
    let body: string | null = null;
    let outFile: string | null = null;
    let silent = false;
    let include = false;
    let verbose = false;
    let location = false;
    const optionValue = (index: number, flag: string): { value: string; next: number } | ExecResult => {
      if (index + 1 >= argv.length) return { stdout: '', stderr: 'curl: option requires an argument: ' + flag + '\n', exitCode: 2 };
      return { value: argv[index + 1]!, next: index + 1 };
    };

    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i]!;
      if (arg === '-X' || arg === '--request') {
        const option = optionValue(i, arg); if ('exitCode' in option) return option; method = option.value; i = option.next;
      } else if (arg === '-H' || arg === '--header') {
        const option = optionValue(i, arg); if ('exitCode' in option) return option;
        const split = option.value.indexOf(':');
        if (split <= 0) return { stdout: '', stderr: 'curl: invalid header: ' + option.value + '\n', exitCode: 2 };
        headers[option.value.slice(0, split).trim()] = option.value.slice(split + 1).trim(); i = option.next;
      } else if (arg === '-d' || arg === '--data' || arg === '--data-raw') {
        const option = optionValue(i, arg); if ('exitCode' in option) return option; body = option.value; method ??= 'POST'; i = option.next;
      } else if (arg === '-o' || arg === '--output') {
        const option = optionValue(i, arg); if ('exitCode' in option) return option; outFile = option.value; i = option.next;
      } else if (arg === '-s' || arg === '--silent') silent = true;
      else if (arg === '-i' || arg === '--include') include = true;
      else if (arg === '-v' || arg === '--verbose') verbose = true;
      else if (arg === '-L' || arg === '--location') location = true;
      else if (arg === '--url') { const option = optionValue(i, arg); if ('exitCode' in option) return option; url = option.value; i = option.next; }
      else if (!arg.startsWith('-')) url = arg;
      else return { stdout: '', stderr: 'curl: unsupported option: ' + arg + '\n', exitCode: 2 };
    }
    if (!url) return { stdout: '', stderr: 'curl: no URL specified\n', exitCode: 2 };
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

    try {
      const opts: Record<string, unknown> = { method: method ?? 'GET', headers, redirect: location ? 'follow' : 'manual' };
      if (body !== null) opts['body'] = body;
      const res = await fetch(url, opts) as Response;
      let header = '';
      if (include || verbose) {
        const statusLine = 'HTTP/1.1 ' + res.status + ' ' + (res.statusText || '');
        if (verbose) header += '< ' + statusLine + '\n';
        if (include) header += statusLine + '\r\n';
        res.headers.forEach((value, name) => {
          if (verbose) header += '< ' + name + ': ' + value + '\n';
          if (include) header += name + ': ' + value + '\r\n';
        });
        if (include) header += '\r\n';
      }
      const output = concat(new TextEncoder().encode(include ? header : ''), new Uint8Array(await res.arrayBuffer()));
      let stderr = verbose ? header : '';
      if (outFile) {
        const ipc = (globalThis as { ipc?: Ipc }).ipc;
        if (!ipc) throw new Error('TFS bridge unavailable');
        const write = ipc.send({ f: 'fs.writeFileBytes', path: outFile, data: Array.from(output) });
        if (write.error) throw new Error(write.error);
        if (!silent) stderr += 'curl: wrote ' + output.length + ' bytes to ' + outFile + '\n';
      }
      if (!res.ok && !include && !silent) stderr += 'curl: HTTP ' + res.status + ' ' + (res.statusText || '') + '\n';
      return { stdout: outFile ? '' : bytesToLatin1(output), stderr, exitCode: 0, stdoutKind: 'bytes' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return { stdout: '', stderr: 'curl: (' + transportCategory(detail) + ') ' + detail + '\n', exitCode: 6 };
    }
  },
};
