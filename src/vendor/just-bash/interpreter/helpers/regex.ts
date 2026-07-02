// @ts-nocheck — vendored from just-bash (Apache-2.0), keep original strictness assumptions.
/**
 * Regex helper functions for the interpreter.
 */

/**
 * Escape a string for use as a literal in a regex pattern.
 * All regex special characters are escaped.
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
