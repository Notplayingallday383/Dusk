import { describe, it, expect } from 'vitest';
import { bootRepl } from '../src/index';

// Engine lacks TextDecoder; decode byte-by-byte via String.fromCharCode.
const decodeBytes = (bytes: number[] | Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode((bytes as ArrayLike<number>)[i]!);
  return s;
};

describe('default /bin/sh is shell-v2', () => {
  it('runs a C-for via processManager.spawnSync /bin/sh -c', async () => {
    const out: string[] = [];
    const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
    try {
      const r = await repl.processManager.spawnSync(
        '/bin/sh',
        ['-c', 'for ((i=0;i<2;i++)); do echo $i; done'],
        { cwd: '/' },
      );
      expect(r.status).toBe(0);
      expect(decodeBytes(r.stdout)).toBe('0\n1\n');
    } finally {
      repl.engine.terminate();
    }
  }, 60_000);

  it('runs a [[ ]] via processManager.spawnSync /bin/sh -c', async () => {
    const out: string[] = [];
    const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
    try {
      const r = await repl.processManager.spawnSync(
        '/bin/sh',
        ['-c', '[[ abc == a* ]] && echo yes'],
        { cwd: '/' },
      );
      expect(r.status).toBe(0);
      expect(decodeBytes(r.stdout)).toBe('yes\n');
    } finally {
      repl.engine.terminate();
    }
  }, 60_000);
});
