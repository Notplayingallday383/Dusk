import { beforeEach, expect, test, vi } from 'vitest';
import * as nova from '@nightnetwork/nova';

const { bootRepl } = vi.hoisted(() => ({ bootRepl: vi.fn() }));
const { terminals, fitAddons, walkOpfs } = vi.hoisted(() => ({
  terminals: [] as Array<{
    open: ReturnType<typeof vi.fn>;
    write: ReturnType<typeof vi.fn>;
    loadAddon: ReturnType<typeof vi.fn>;
    cols: number;
    rows: number;
    dispose: ReturnType<typeof vi.fn>;
    onData: ReturnType<typeof vi.fn>;
    emitData: (data: string) => void;
  }>,
  fitAddons: [] as Array<{ fit: ReturnType<typeof vi.fn> }>,
  walkOpfs: vi.fn().mockResolvedValue('/home/dusk'),
}));

vi.mock('../src/index', () => ({ bootRepl }));
vi.mock('../src/demo/opfs-view', () => ({ clearOpfs: vi.fn(), walkOpfs }));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    open = vi.fn();
    write = vi.fn();
    loadAddon = vi.fn();
    cols = 80;
    rows = 24;
    dispose = vi.fn();
    private dataListener: ((data: string) => void) | undefined;
    onData = vi.fn((listener: (data: string) => void) => {
      this.dataListener = listener;
      return { dispose: vi.fn() };
    });

    constructor() {
      terminals.push(this);
    }

    emitData(data: string): void {
      this.dataListener?.(data);
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = vi.fn();

    constructor() {
      fitAddons.push(this);
    }
  },
}));

import { startPage } from '../src/demo/page';

const emptyStream = (): ReadableStream<Uint8Array> => new ReadableStream({ start(controller) { controller.close(); } });

beforeEach(() => {
  Object.defineProperty(globalThis, 'crossOriginIsolated', { configurable: true, value: true });
  bootRepl.mockReset();
  terminals.length = 0;
  fitAddons.length = 0;
  walkOpfs.mockClear();
  bootRepl.mockResolvedValue({
    processManager: {
      spawn: vi.fn().mockResolvedValue({
        stdin: { write: vi.fn() },
        stdout: emptyStream(),
        stderr: emptyStream(),
        exit: new Promise<number>(() => {}),
        master: { onMasterData: vi.fn(), resize: vi.fn() },
      }),
    },
  });
  document.body.innerHTML = `
    <div id="terminal"></div><div id="examples"></div>
    <div id="node-examples"></div><div id="crypto-examples"></div>
    <div id="sqlite-examples"></div><div id="python-examples"></div>
    <pre id="fsview"></pre><button id="clearfs"></button>`;
});

test('demo routes the dsh PTY through xterm, refreshes OPFS after input, and disposes on unload', async () => {
  await startPage();

  const terminal = terminals[0]!;
  const repl = await bootRepl.mock.results[0]!.value;
  const shell = await (repl.processManager.spawn as ReturnType<typeof vi.fn>).mock.results[0]!.value;
  const onMasterData = shell.master.onMasterData.mock.calls[0]![0] as (bytes: Uint8Array) => void;

  expect(terminal.open).toHaveBeenCalledWith(document.getElementById('terminal'));
  onMasterData(new TextEncoder().encode('dusk$ '));
  expect(terminal.write).toHaveBeenCalledWith('dusk$ ');

  terminal.emitData('pwd\r');
  await vi.waitFor(() => expect(shell.stdin.write).toHaveBeenCalled());
  expect(new TextDecoder().decode(shell.stdin.write.mock.calls[0]![0])).toBe('pwd\n');
  expect(walkOpfs).toHaveBeenCalledTimes(2);

  window.dispatchEvent(new Event('resize'));
  expect(fitAddons[0]!.fit).toHaveBeenCalled();
  expect(shell.master.resize).toHaveBeenCalledWith(80, 24);
  window.dispatchEvent(new Event('beforeunload'));
  expect(terminal.dispose).toHaveBeenCalled();
});

test('demo shell starts in the persistent user home', async () => {
  await startPage();

  expect(bootRepl).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ user: 'dusk' }));
  const repl = await bootRepl.mock.results[0]!.value;
  const spawn = repl.processManager.spawn as ReturnType<typeof vi.fn>;
  expect(spawn).toHaveBeenCalledWith('/bin/dsh', [], expect.objectContaining({
    cwd: '/home/dusk',
    env: expect.objectContaining({
      HOME: '/home/dusk',
      DPM_REGISTRY: 'https://registry.dusk.night-x.com/',
    }),
  }));
});

test('demo default Nova loader exposes workspace TLS socket and server capabilities', async () => {
  await startPage();

  const options = bootRepl.mock.calls[0]![1] as {
    net: { loadLibcurl: () => Promise<{ TLSSocket: new (host: string, port: number) => unknown }> };
  };
  const libcurl = await options.net.loadLibcurl();

  expect(libcurl.TLSSocket).toBeTypeOf('function');
  expect(nova.NovaTlsServerConnection).toBeTypeOf('function');
});

test('demo boot config enables generic outbound TCP without SSH-specific host configuration', async () => {
  await startPage();

  const options = bootRepl.mock.calls[0]![1] as { net: { proxyUrl: string }; ssh?: unknown };
  expect(options.net.proxyUrl).toBe('wss://gointospace.app/wisp/');
  expect(options).not.toHaveProperty('ssh');
  expect(options.net).toHaveProperty('tcp');
});
