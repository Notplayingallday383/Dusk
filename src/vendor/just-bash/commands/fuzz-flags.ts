// @ts-nocheck — vendored from just-bash (Apache-2.0), stubbed out for DuskJS.
// Original aggregator imported every command's flagsForFuzzing map. In DuskJS
// several commands (gzip/tar/sqlite3/xan/html-to-markdown) are omitted from
// the vendored subset, so the aggregator is stubbed to an empty map.
// This module is only used by fuzz test infrastructure that DuskJS doesn't
// ship anyway.
export const commandFlagsForFuzzing = new Map();
export const commandUnaliasFlagsForFuzzing = new Map();
export const getAllCommandFuzzInfo = (): Map<string, unknown> => new Map();
