// DPM CLI bundles registered as DuskJS builtin binaries.
//
// These are esbuild-bundled CJS bundles of the dpm/dpx/npm/npx/pnpm CLIs,
// imported as raw text via Vite's ?raw query and registered with
// ProcessManager.registerBinary().

import dpmBundle from './dpm-bundles/dpm-bundle.js?raw';
import dpxBundle from './dpm-bundles/dpx-bundle.js?raw';
import npmBundle from './dpm-bundles/npm-bundle.js?raw';
import npxBundle from './dpm-bundles/npx-bundle.js?raw';
import pnpmBundle from './dpm-bundles/pnpm-bundle.js?raw';

export const DPM_BUNDLES: Record<string, string> = {
  '/bin/dpm': dpmBundle,
  '/bin/dpx': dpxBundle,
  '/bin/npm': npmBundle,
  '/bin/npx': npxBundle,
  '/bin/pnpm': pnpmBundle,
};
