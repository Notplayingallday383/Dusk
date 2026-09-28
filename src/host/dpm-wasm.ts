export interface DpmHttpResponse {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export interface DpmHostCapabilities {
  read(path: string): Promise<string>;
  atomicWrite(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  mkdir(path: string): Promise<void>;
  fetch(url: string): Promise<DpmHttpResponse>;
  fetchBytes(url: string): Promise<Uint8Array>;
  readBytes(path: string): Promise<Uint8Array>;
  readDir(path: string): Promise<string[]>;
  stat(path: string): Promise<'file' | 'directory' | 'symlink'>;
  atomicWriteBytes(path: string, content: Uint8Array): Promise<void>;
  stdout(content: string): Promise<void>;
  stderr(content: string): Promise<void>;
}

export interface DpmWasmResult {
  status: number;
  stdout?: string;
  stderr?: string;
  plan?: DpmExecutionPlan;
}

export interface DpmExecutionPlan {
  command: string;
  args: string[];
  env: Record<string, string>;
  stdin?: number[];
}

export interface DpmExecutionContext {
  env: Record<string, string>;
  stdin?: number[];
}

export interface DpmWasmCommand {
  execute(args: string[], capabilities: DpmHostCapabilities, cwd: string, context: DpmExecutionContext): DpmWasmResult | Promise<DpmWasmResult>;
}

export type DpmWasmModule = {
  default: (input?: { module_or_path: string | URL }) => Promise<unknown>;
  execute: (args: string[], capabilities: DpmHostCapabilities, cwd: string, context: DpmExecutionContext) => Promise<DpmWasmResult>;
};

export const createDpmWasmCommandLoader = (
  loadModule: () => Promise<DpmWasmModule>,
  wasmUrl?: string,
): (() => Promise<DpmWasmCommand>) => {
  let command: Promise<DpmWasmCommand> | undefined;
  return () => {
    if (!command) {
      command = loadModule().then(async (module) => {
        await module.default(wasmUrl === undefined ? undefined : { module_or_path: wasmUrl });
        return {
          execute: (args: string[], capabilities: DpmHostCapabilities, cwd: string, context: DpmExecutionContext) => module.execute(args, capabilities, cwd, context),
        };
      });
      void command.catch(() => { command = undefined; });
    }
    return command;
  };
};

export const loadDpmWasmCommand = createDpmWasmCommandLoader(() => import('@nightnetwork/dpm'), dpmWasmUrl);
import dpmWasmUrl from '@nightnetwork/dpm/wasm?url&no-inline';
