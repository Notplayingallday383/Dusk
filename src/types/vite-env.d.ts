/// <reference types="vite/client" />

declare module '*?worldsrc' {
  const src: string;
  export default src;
}

declare module 'libcurl.js' {
  export const libcurl: unknown;
}

declare module 'libcurl.js/bundled' {
  export const libcurl: unknown;
}

declare module 'nova-wasm' {
  export default function init(): Promise<void>;
  export class LibCurl {
    constructor();
    load_wasm(url?: string): Promise<void>;
    set_websocket(url: string): void;
    fetch(url: string, opts?: unknown): Promise<Response>;
    readonly transport: string;
    readonly version: string;
    // WebSocket, HTTPSession, TLSSocket are exposed as JsValue getters that
    // return either a class constructor or undefined; typed as `unknown`
    // here since DuskJS feature-detects them.
    readonly WebSocket: unknown;
    readonly HTTPSession: unknown;
    readonly TLSSocket: unknown;
  }
}
