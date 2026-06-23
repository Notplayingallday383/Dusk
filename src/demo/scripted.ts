import { bootRepl } from '../index';
import { TRANSCRIPT_LINES, TRANSCRIPT_SEED, makeStubLibcurl } from './transcript';

export const startScripted = async (): Promise<void> => {
  const out = document.getElementById('out') as HTMLPreElement;
  const write = (text: string): void => {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  };

  if (!crossOriginIsolated) { write('error: not cross-origin isolated\n'); return; }

  write('booting DuskJS (scripted demo)...\n');
  const repl = await bootRepl(write, {
    net: { loadLibcurl: async () => makeStubLibcurl(), proxyUrl: 'wss://stub/ws/' },
    seed: TRANSCRIPT_SEED,
  });
  write('ready.\n\n');

  for (const line of TRANSCRIPT_LINES) {
    write('> ' + line + '\n');
    await repl.feed(line + '\n');
    await new Promise((r) => setTimeout(r, 200));
  }
  write('\n-- scripted demo complete --\n');
};
