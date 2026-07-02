// @ts-nocheck — vendored from just-bash (Apache-2.0), keep original strictness assumptions.
/**
 * AWK Interpreter Module
 *
 * Re-exports the public API for the AWK interpreter.
 */

export {
  type AwkRuntimeContext,
  type CreateContextOptions,
  createRuntimeContext,
} from "./context.js";
export { AwkInterpreter } from "./interpreter.js";
export type { AwkFileSystem, AwkValue } from "./types.js";
