export interface NativePackageReplacementScope {
  packageVersion?: string;
  packagePathSuffix?: string;
  packageEntryPath?: string;
}

export type NativePackageReplacementEntry = readonly [
  specifier: string,
  source: string,
  scope?: NativePackageReplacementScope,
];

export type NativePackageReplacementEntries =
  | Readonly<Record<string, string>>
  | readonly NativePackageReplacementEntry[];

export interface NativePackageRequest {
  packageRoot?: string;
  packageVersion?: string;
  packageEntryPath?: string;
}

export interface NativePackageRegistry {
  resolve(request: string, packageRequest?: NativePackageRequest): string | undefined;
  readSource(path: string): string | undefined;
}

const VIRTUAL_ROOT = '/.dusk-native-fallback/';
const segmentPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const invalidReplacement = (specifier: string): Error =>
  new Error(`Invalid native package replacement '${specifier}'`);

const validateSpecifier = (specifier: string): void => {
  if (!specifier || specifier.startsWith('/') || specifier.startsWith('.') || specifier.includes('\\') || specifier.endsWith('.node')) {
    throw invalidReplacement(specifier);
  }
  const segments = specifier.split('/');
  const packageSegments = specifier.startsWith('@') ? 2 : 1;
  if (segments.length < packageSegments || segments.some((segment) => !segmentPattern.test(segment.replace(/^@/, '')))) {
    throw invalidReplacement(specifier);
  }
};

const nativeAddonError = (request: string): Error =>
  Object.assign(
    new Error(`ERR_DLOPEN_FAILED: native addon '${request}' is unsupported by the browser ABI`),
    { code: 'ERR_DLOPEN_FAILED' },
  );

export const createNativePackageRegistry = (entries: NativePackageReplacementEntries = {}): NativePackageRegistry => {
  const replacements = new Map<string, { path: string; scope?: NativePackageReplacementScope }>();
  const virtualSources = new Map<string, string>();
  const pairs: readonly NativePackageReplacementEntry[] = Array.isArray(entries)
    ? entries
    : Object.entries(entries).map(([specifier, source]) => [specifier, source]);

  for (const [specifier, source, scope] of pairs) {
    validateSpecifier(specifier);
    if (typeof source !== 'string') throw invalidReplacement(specifier);
    if (replacements.has(specifier)) throw new Error(`Duplicate native package replacement '${specifier}'`);
    const path = VIRTUAL_ROOT + encodeURIComponent(specifier) + '.js';
    replacements.set(specifier, scope ? { path, scope } : { path });
    virtualSources.set(path, source);
  }

  return Object.freeze({
    resolve(request: string, packageRequest?: NativePackageRequest): string | undefined {
      if (virtualSources.has(request)) return request;
      const replacement = replacements.get(request);
      if (replacement !== undefined) {
        const { scope } = replacement;
        if (!scope || (
          (!scope.packageVersion || scope.packageVersion === packageRequest?.packageVersion)
          && (!scope.packagePathSuffix || packageRequest?.packageRoot?.endsWith(scope.packagePathSuffix))
        )) {
          const path = scope && (
            packageRequest?.packageEntryPath
            ?? (scope.packageEntryPath && packageRequest?.packageRoot
              ? `${packageRequest.packageRoot}/${scope.packageEntryPath}`
              : undefined)
          ) || replacement.path;
          virtualSources.set(path, virtualSources.get(replacement.path)!);
          return path;
        }
      }
      if (request.endsWith('.node')) throw nativeAddonError(request);
      return undefined;
    },
    readSource(path: string): string | undefined {
      const source = virtualSources.get(path);
      if (source !== undefined) return source;
      if (path.startsWith(VIRTUAL_ROOT)) throw nativeAddonError(path);
      return undefined;
    },
  });
};
