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
