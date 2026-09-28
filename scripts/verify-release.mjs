import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const projectRoot = resolve(import.meta.dirname, '..');
const output = await mkdtemp(join(tmpdir(), 'dusk-release-'));

try {
  const packed = execFileSync('npm', ['pack', '--pack-destination', output], {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'inherit'],
  }).trim().split('\n').at(-1);
  if (!packed) throw new Error('npm pack did not report an archive');
  const archive = join(output, packed);
  execFileSync(process.execPath, ['scripts/test-package-artifact.mjs', archive], { cwd: projectRoot, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/test-vite-consumer.mjs', archive], { cwd: projectRoot, stdio: 'inherit' });
} finally {
  await rm(output, { recursive: true, force: true });
}
