// /bin/node — DuskJS Node.js launcher binary.
//
// Usage:
//   node script.js           — run a script file (CJS or ESM auto-detected)
//   node -e <expr>           — evaluate inline expression
//   node -p <expr>           — evaluate and print result
//   node --version           — print Node version
//
// CJS scripts are wrapped in a function with (exports, require, module, __filename, __dirname).
// ESM scripts (.mjs, or .js with adjacent package.json "type":"module") go through __import__.

import './main';
