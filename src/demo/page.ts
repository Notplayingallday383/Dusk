import { bootRepl } from '../index';
import { TRANSCRIPT_LINES, TRANSCRIPT_SEED } from './transcript';
import { walkOpfs, clearOpfs } from './opfs-view';
import type { LibCurl } from '../host/net';

const loadRealLibcurl = async (): Promise<LibCurl> =>
  (await import('libcurl.js/bundled')).libcurl as unknown as LibCurl;

export const startPage = async (): Promise<void> => {
  const out = document.getElementById('out') as HTMLPreElement;
  const line = document.getElementById('line') as HTMLInputElement;
  const examples = document.getElementById('examples') as HTMLDivElement;
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
  write('ready. (fs is persistent via TFS/OPFS)\n');
  await refreshFsView();

  const submit = async (text: string): Promise<void> => {
    write('> ' + text + '\n');
    await repl.feed(text + '\n');
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

  for (const ex of TRANSCRIPT_LINES) {
    const btn = document.createElement('button');
    btn.textContent = ex;
    btn.addEventListener('click', () => { void submit(ex); });
    examples.appendChild(btn);
  }
};
