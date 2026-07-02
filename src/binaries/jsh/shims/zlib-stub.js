// Stub for node:zlib in the engine bundle.
//
// just-bash's gzip/gunzip/zcat commands import node:zlib. The DuskJS engine
// runs inside a WASI SpiderMonkey and does not have zlib. We provide minimal
// throwing shims so the module can be imported without breaking the bundle;
// calling any of these at runtime yields a clear error rather than a
// mysterious "not a function" from unbundled code.
const notSupported = (fnName) => () => {
  throw new Error("jsh: node:zlib is not available in the DuskJS engine (called " + fnName + ")");
};

export const gzipSync = notSupported("gzipSync");
export const gunzipSync = notSupported("gunzipSync");
export const deflateSync = notSupported("deflateSync");
export const inflateSync = notSupported("inflateSync");
export const brotliCompressSync = notSupported("brotliCompressSync");
export const brotliDecompressSync = notSupported("brotliDecompressSync");
export const createGzip = notSupported("createGzip");
export const createGunzip = notSupported("createGunzip");
export const createDeflate = notSupported("createDeflate");
export const createInflate = notSupported("createInflate");

// zlib.constants — some callers reference this for flush codes etc.
// Provide the standard set of numeric constants (matches Node's values).
export const constants = {
  Z_NO_FLUSH: 0,
  Z_PARTIAL_FLUSH: 1,
  Z_SYNC_FLUSH: 2,
  Z_FULL_FLUSH: 3,
  Z_FINISH: 4,
  Z_BLOCK: 5,
  Z_TREES: 6,
  Z_OK: 0,
  Z_STREAM_END: 1,
  Z_NEED_DICT: 2,
  Z_ERRNO: -1,
  Z_STREAM_ERROR: -2,
  Z_DATA_ERROR: -3,
  Z_MEM_ERROR: -4,
  Z_BUF_ERROR: -5,
  Z_VERSION_ERROR: -6,
  Z_NO_COMPRESSION: 0,
  Z_BEST_SPEED: 1,
  Z_BEST_COMPRESSION: 9,
  Z_DEFAULT_COMPRESSION: -1,
  Z_FILTERED: 1,
  Z_HUFFMAN_ONLY: 2,
  Z_RLE: 3,
  Z_FIXED: 4,
  Z_DEFAULT_STRATEGY: 0,
  ZLIB_VERNUM: 0x12b0,
  DEFLATE: 1,
  INFLATE: 2,
  GZIP: 3,
  GUNZIP: 4,
  DEFLATERAW: 5,
  INFLATERAW: 6,
  UNZIP: 7,
  BROTLI_DECODE: 8,
  BROTLI_ENCODE: 9,
  Z_MIN_WINDOWBITS: 8,
  Z_MAX_WINDOWBITS: 15,
  Z_DEFAULT_WINDOWBITS: 15,
  Z_MIN_CHUNK: 64,
  Z_MAX_CHUNK: Infinity,
  Z_DEFAULT_CHUNK: 16384,
  Z_MIN_MEMLEVEL: 1,
  Z_MAX_MEMLEVEL: 9,
  Z_DEFAULT_MEMLEVEL: 8,
  Z_MIN_LEVEL: -1,
  Z_MAX_LEVEL: 9,
  Z_DEFAULT_LEVEL: -1,
};

export default {
  gzipSync,
  gunzipSync,
  deflateSync,
  inflateSync,
  brotliCompressSync,
  brotliDecompressSync,
  createGzip,
  createGunzip,
  createDeflate,
  createInflate,
  constants,
};
