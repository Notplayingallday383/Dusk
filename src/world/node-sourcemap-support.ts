// node:sourcemap-support — minimal source-map-aware stack rewriting.
//
// Decodes Base64 VLQ source maps and rewrites Error.prototype.stack on access.
// Install via `require('node:sourcemap-support').install()`.

declare const ipc: { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

interface SourceMapV3 {
  version: number;
  sources: string[];
  names: string[];
  mappings: string;
  sourceRoot?: string;
  file?: string;
  sourcesContent?: (string | null)[];
}

interface DecodedMapping {
  generatedLine: number;
  generatedColumn: number;
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
  nameIndex: number;
}

const VLQ_BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VLQ_BASE_SHIFT = 5;
const VLQ_BASE = 1 << VLQ_BASE_SHIFT;
const VLQ_BASE_MASK = VLQ_BASE - 1;
const VLQ_CONTINUATION_BIT = VLQ_BASE;

const decodeVLQ = (input: string, start: number): { value: number; next: number } => {
  let result = 0;
  let shift = 0;
  let i = start;
  while (true) {
    if (i >= input.length) break;
    const digit = VLQ_BASE64.indexOf(input[i]!);
    if (digit === -1) { i++; continue; }
    i++;
    const continuation = (digit & VLQ_CONTINUATION_BIT) !== 0;
    const value = digit & VLQ_BASE_MASK;
    result += value << shift;
    if (!continuation) break;
    shift += VLQ_BASE_SHIFT;
  }
  const negate = (result & 1) === 1;
  const signed = result >> 1;
  return { value: negate ? -signed : signed, next: i };
};

const decodeMappings = (mappings: string): DecodedMapping[] => {
  const out: DecodedMapping[] = [];
  let generatedLine = 0;
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  for (const line of mappings.split(';')) {
    let generatedColumn = 0;
    for (const segment of line.split(',')) {
      if (!segment) continue;
      let i = 0;
      const fields: number[] = [];
      while (i < segment.length) {
        const r = decodeVLQ(segment, i);
        fields.push(r.value);
        i = r.next;
      }
      if (fields.length === 0) continue;
      generatedColumn += fields[0]!;
      const mapping: DecodedMapping = {
        generatedLine,
        generatedColumn,
        sourceIndex: -1,
        originalLine: -1,
        originalColumn: -1,
        nameIndex: -1,
      };
      if (fields.length >= 4) {
        sourceIndex += fields[1]!;
        originalLine += fields[2]!;
        originalColumn += fields[3]!;
        mapping.sourceIndex = sourceIndex;
        mapping.originalLine = originalLine;
        mapping.originalColumn = originalColumn;
        if (fields.length >= 5) {
          nameIndex += fields[4]!;
          mapping.nameIndex = nameIndex;
        }
      }
      out.push(mapping);
    }
    generatedLine++;
  }
  return out;
};

const mapCache = new Map<string, { map: SourceMapV3; mappings: DecodedMapping[] } | null>();

const readFileSync = (path: string): string | null => {
  try {
    const r = ipc.send({ f: 'fs.readFile', path });
    if (r.error) return null;
    return r.value as string;
  } catch { return null; }
};

const loadSourceMap = (filename: string): { map: SourceMapV3; mappings: DecodedMapping[] } | null => {
  if (mapCache.has(filename)) return mapCache.get(filename) ?? null;

  const source = readFileSync(filename);
  if (!source) { mapCache.set(filename, null); return null; }

  const match = /\/\/[#@]\s*sourceMappingURL=(.+)/.exec(source);
  if (!match) { mapCache.set(filename, null); return null; }
  const url = match[1]!.trim();

  let mapJson: string | null = null;
  if (url.startsWith('data:application/json')) {
    const b64Idx = url.indexOf('base64,');
    if (b64Idx !== -1) {
      try {
        const g = globalThis as Record<string, unknown>;
        const Buffer = g['Buffer'] as undefined | { from(s: string, enc: string): { toString(enc: string): string } };
        if (Buffer) mapJson = Buffer.from(url.slice(b64Idx + 7), 'base64').toString('utf8');
      } catch { /* */ }
    } else {
      const dataIdx = url.indexOf(',');
      if (dataIdx !== -1) mapJson = decodeURIComponent(url.slice(dataIdx + 1));
    }
  } else {
    // Resolve relative path
    const dir = filename.split('/').slice(0, -1).join('/') || '/';
    const mapPath = url.startsWith('/') ? url : dir + '/' + url;
    mapJson = readFileSync(mapPath);
  }

  if (!mapJson) { mapCache.set(filename, null); return null; }
  try {
    const map = JSON.parse(mapJson) as SourceMapV3;
    const mappings = decodeMappings(map.mappings ?? '');
    const result = { map, mappings };
    mapCache.set(filename, result);
    return result;
  } catch {
    mapCache.set(filename, null);
    return null;
  }
};

const findMapping = (mappings: DecodedMapping[], line: number, column: number): DecodedMapping | null => {
  // Binary-search-like: find the largest mapping <= (line, column) on the same generated line.
  let best: DecodedMapping | null = null;
  for (const m of mappings) {
    if (m.generatedLine > line - 1) break;
    if (m.generatedLine < line - 1) { best = m; continue; }
    if (m.generatedColumn <= column - 1) best = m;
    else break;
  }
  return best;
};

const rewriteStack = (stack: string): string => {
  return stack.split('\n').map((line) => {
    // Match V8-style or SpiderMonkey-style frames:
    //   "    at foo (file:line:col)"
    //   "foo@file:line:col"
    const v8 = /^(\s*at\s+)(?:(.*?)\s+\()?(.+):(\d+):(\d+)\)?$/.exec(line);
    const sm = /^(.*?)@(.+):(\d+):(\d+)$/.exec(line);
    let prefix: string, file: string, lineNum: number, colNum: number, suffix: string;
    if (v8) {
      prefix = v8[1]! + (v8[2] ? `${v8[2]} (` : '');
      file = v8[3]!;
      lineNum = parseInt(v8[4]!, 10);
      colNum = parseInt(v8[5]!, 10);
      suffix = v8[2] ? ')' : '';
    } else if (sm) {
      prefix = sm[1] ? `${sm[1]}@` : '';
      file = sm[2]!;
      lineNum = parseInt(sm[3]!, 10);
      colNum = parseInt(sm[4]!, 10);
      suffix = '';
    } else {
      return line;
    }
    const map = loadSourceMap(file);
    if (!map) return line;
    const mapping = findMapping(map.mappings, lineNum, colNum);
    if (!mapping || mapping.sourceIndex < 0) return line;
    const source = map.map.sources[mapping.sourceIndex] ?? file;
    return `${prefix}${source}:${mapping.originalLine + 1}:${mapping.originalColumn + 1}${suffix}`;
  }).join('\n');
};

let installed = false;

export const install = (): void => {
  if (installed) return;
  installed = true;
  const origGet = Object.getOwnPropertyDescriptor(Error.prototype, 'stack')?.get;
  Object.defineProperty(Error.prototype, 'stack', {
    configurable: true,
    get(this: Error): string | undefined {
      const raw = (this as Error & { _rawStack?: string })._rawStack;
      if (raw !== undefined) return raw;
      let stack: string | undefined;
      try {
        stack = origGet ? origGet.call(this) as string : undefined;
      } catch {
        stack = undefined;
      }
      if (typeof stack === 'string') {
        try { stack = rewriteStack(stack); } catch { /* */ }
        (this as Error & { _rawStack?: string })._rawStack = stack;
      }
      return stack;
    },
  });
};

export const uninstall = (): void => {
  installed = false;
  // We don't restore the original getter; this is best-effort.
};

export const mapSourcePosition = (filename: string, line: number, column: number): { source: string; line: number; column: number } | null => {
  const map = loadSourceMap(filename);
  if (!map) return null;
  const mapping = findMapping(map.mappings, line, column);
  if (!mapping || mapping.sourceIndex < 0) return null;
  return {
    source: map.map.sources[mapping.sourceIndex] ?? filename,
    line: mapping.originalLine + 1,
    column: mapping.originalColumn + 1,
  };
};

export const nodeSourceMapSupport = {
  install,
  uninstall,
  mapSourcePosition,
};
