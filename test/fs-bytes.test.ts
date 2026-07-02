import { test, expect } from 'vitest';
import { createVFS } from '../src/host/vfs';
import { createMemoryBackend } from '../src/host/fs-backend';

test('vfs stores arbitrary bytes losslessly (including 0x00, 0xFF, non-UTF-8)', () => {
  const vfs = createVFS();
  const bytes = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF, 0xFE, 0xFD]);
  vfs.writeFileBytes('/img.png', bytes);
  const out = vfs.readFileBytes('/img.png');
  expect(out).toBeInstanceOf(Uint8Array);
  expect(Array.from(out)).toEqual(Array.from(bytes));
  expect(vfs.fileSize('/img.png')).toBe(bytes.length);
});

test('vfs string ops remain valid utf-8 round trip', () => {
  const vfs = createVFS();
  vfs.writeFile('/t.txt', 'héllo 🌍');
  expect(vfs.readFile('/t.txt')).toBe('héllo 🌍');
});

test('memory FSBackend exposes byte ops with PNG magic round trip', async () => {
  const fs = createMemoryBackend();
  const png = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0xFF]);
  await fs.writeFileBytes!('/img.png', png);
  const out = await fs.readFileBytes!('/img.png');
  expect(Array.from(out)).toEqual(Array.from(png));
});

import { bootRepl } from '../src/index';

test('binary round trip end-to-end: writeFileBytes + readFileBytes via fs.promises', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed([
    'const fs = require("node:fs");',
    'const bytes = new Uint8Array([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A,0x00,0xFF,0xFE,0xFD]);',
    'await fs.promises.writeFile("/img.png", bytes);',
    'const got = await fs.promises.readFile("/img.png");',
    'console.log("LEN:" + got.length);',
    'console.log("HEX:" + Array.from(got).map(b => b.toString(16).padStart(2,"0")).join(""));',
    ''
  ].join(' '));
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('HEX:') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = out.join('');
  expect(text).toContain('LEN:12');
  expect(text).toContain('HEX:89504e470d0a1a0a00fffefd');
}, 60_000);
