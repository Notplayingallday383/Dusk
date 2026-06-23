export interface BufferInit {
  lengthBuffer: SharedArrayBuffer;
  valueBuffer: SharedArrayBuffer;
  js: string;
}

export interface WaitMessage { type: 'wait'; }
export interface EvalMessage { type: 'eval'; js: string; }
export interface DoneMessage { type: 'done'; ret?: unknown; }
export interface ReadyMessage { type: 'ready'; }

export interface FuncMessage {
  f: string;
  [key: string]: unknown;
}

export type WorldToHost =
  | WaitMessage
  | DoneMessage
  | ReadyMessage
  | FuncMessage;

export type HostToWorld =
  | EvalMessage
  | { value?: unknown; ptr?: number };

export const SERIAL_RES_SIZE = 1024 * 1024 * 10;
