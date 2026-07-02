import { test, expect } from 'vitest';
import { createFDTable } from '../src/host/fd-table';
import { bootRepl } from '../src/index';

test('FDTable allocates fds starting at 3 and reuses freed numbers (lowest-first)', () => {
  const tbl = createFDTable();
  const a = tbl.allocate({ backendHandle: 1, path: '/a', flags: 0, appendOnly: false });
  const b = tbl.allocate({ backendHandle: 2, path: '/b', flags: 0, appendOnly: false });
  const c = tbl.allocate({ backendHandle: 3, path: '/c', flags: 0, appendOnly: false });
  expect([a, b, c]).toEqual([3, 4, 5]);
  tbl.release(b);
  const d = tbl.allocate({ backendHandle: 4, path: '/d', flags: 0, appendOnly: false });
  expect(d).toBe(4); // freed slot reused
});

test('FDTable.get returns entry; EBADF on missing', () => {
  const tbl = createFDTable();
  const fd = tbl.allocate({ backendHandle: 10, path: '/x', flags: 0, appendOnly: false });
  expect(tbl.get(fd)?.backendHandle).toBe(10);
  expect(tbl.get(999)).toBeUndefined();
});

test('FDTable.closeAll iterates remaining entries for backend teardown', () => {
  const tbl = createFDTable();
  tbl.allocate({ backendHandle: 1, path: '/a', flags: 0, appendOnly: false });
  tbl.allocate({ backendHandle: 2, path: '/b', flags: 0, appendOnly: false });
  const collected: number[] = [];
  tbl.closeAll((entry) => collected.push(entry.backendHandle));
  expect(collected.sort()).toEqual([1, 2]);
  expect(tbl.size()).toBe(0);
});

test('FDTable enforces EMFILE cap', () => {
  const tbl = createFDTable(/* maxOpen */ 4); // 4 = stdio(3) + 1 user
  tbl.allocate({ backendHandle: 1, path: '/a', flags: 0, appendOnly: false });
  expect(() => tbl.allocate({ backendHandle: 2, path: '/b', flags: 0, appendOnly: false }))
    .toThrow(/EMFILE/);
});

test('host fd: open → write chunks → fsync → close → reopen → partial reads with positions', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed([
    'const fs = require("node:fs");',
    'const fd = fs.openSync("/log.bin", "w");',
    'fs.writeSync(fd, new Uint8Array([0x89,0xfe,0xfd]));',
    'fs.writeSync(fd, new Uint8Array([0x80,0xc0,0xff]));',
    'fs.fsyncSync(fd);',
    'fs.closeSync(fd);',
    'const r = fs.openSync("/log.bin", "r");',
    'const buf = new Uint8Array(2);',
    'const n1 = fs.readSync(r, buf, 0, 2, 1);',
    'console.log("R1:" + n1 + ":" + Array.from(buf).join(","));',
    'const n2 = fs.readSync(r, buf, 0, 2, 4);',
    'console.log("R2:" + n2 + ":" + Array.from(buf).join(","));',
    'fs.closeSync(r);',
    ''
  ].join(' '));
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('R2:') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  const text = out.join('');
  expect(text).toContain('R1:2:254,253');
  expect(text).toContain('R2:2:192,255');
}, 60_000);

test('host fd: EBADF on read after close', async () => {
  const out: string[] = [];
  const repl = await bootRepl((t) => out.push(t), { fs: 'memory' });
  await repl.feed([
    'const fs = require("node:fs");',
    'fs.writeFileSync("/x", "hi");',
    'const fd = fs.openSync("/x", "r");',
    'fs.closeSync(fd);',
    'try { fs.readSync(fd, new Uint8Array(2), 0, 2, 0); console.log("NO_ERR"); }',
    'catch (e) { console.log("CODE:" + (e.code || "<none>")); }',
    ''
  ].join(' '));
  const deadline = Date.now() + 10_000;
  while (out.join('').indexOf('CODE:') === -1 && out.join('').indexOf('NO_ERR') === -1 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(out.join('')).toContain('CODE:EBADF');
}, 60_000);
