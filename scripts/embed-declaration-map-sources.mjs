import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const libRoot = resolve(import.meta.dirname, '..', 'lib');
const workstationPath = /(?:\/home\/[^/\s]+\/|\/Users\/[^/\s]+\/(?:Projects|Documents)\/|[A-Za-z]:\\Users\\[^\\\s]+\\(?:Projects|Documents)\\)/g;

const visit = async (directory) => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path);
      continue;
    }
    if (!entry.name.endsWith('.map')) continue;

    const map = JSON.parse(await readFile(path, 'utf8'));
    if (entry.name.endsWith('.d.ts.map')) {
      const sourceRoot = map.sourceRoot ?? '';
      map.sourcesContent = await Promise.all(
        (map.sources ?? []).map((source) => readFile(resolve(dirname(path), sourceRoot, source), 'utf8')),
      );
    }
    map.sourcesContent = (map.sourcesContent ?? []).map((source) => source.replace(workstationPath, '<workspace>/'));
    await writeFile(path, JSON.stringify(map));
  }
};

await visit(libRoot);
