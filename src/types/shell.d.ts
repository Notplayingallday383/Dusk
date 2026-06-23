export {};

declare global {
  function print(s: string): void;
  function readline(): string;
  const os: { file: { readFile(path: string): string } };

  interface DuskIpc {
    send: (msg: unknown, ignoreEval?: boolean) => { type?: string; js?: string; value?: unknown };
    recv: (ignoreEval: boolean) => unknown;
  }

  // eslint-disable-next-line no-var
  var ipc: DuskIpc;
  // eslint-disable-next-line no-var
  var evalQueue: unknown[];
}
