import { bootRepl } from "../duskjs.js";
import { T as TRANSCRIPT_LINES, a as TRANSCRIPT_SEED, m as makeStubLibcurl } from "./transcript-mXMTOQd9.js";
const startScripted = async () => {
  const out = document.getElementById("out");
  const write = (text) => {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  };
  if (!crossOriginIsolated) {
    write("error: not cross-origin isolated\n");
    return;
  }
  write("booting DuskJS (scripted demo)...\n");
  const repl = await bootRepl(write, {
    net: { loadLibcurl: async () => makeStubLibcurl(), proxyUrl: "wss://stub/ws/" },
    seed: TRANSCRIPT_SEED
  });
  write("ready.\n\n");
  for (const line of TRANSCRIPT_LINES) {
    write("> " + line + "\n");
    await repl.feed(line + "\n");
    await new Promise((r) => setTimeout(r, 200));
  }
  write("\n-- scripted demo complete --\n");
};
export {
  startScripted
};
//# sourceMappingURL=scripted-CnELYgpv.js.map
