import { expect, test } from 'vitest';
import { createEngine, createEngineFactory, createNativeEngine, type EngineFactory, type EngineInstance, type FuncTable } from '../src/host/engine-instance';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

const createRecordingFactory = (pids: number[], funcsByPid: Map<number, FuncTable>): EngineFactory => {
  return async (pid, funcs = {}) => {
    pids.push(pid);
    funcsByPid.set(pid, funcs);
    let exit = 0;
    let resolveExit: (code: number) => void = () => {};
    const exited = new Promise<number>((resolve) => { resolveExit = resolve; });
    const engine: EngineInstance = {
      pid,
      run: async () => { resolveExit(exit); },
      dispatch: async () => {},
      terminate: async () => { exit = 1; resolveExit(exit); return exit; },
      exited,
    };
    return engine;
  };
};

test('native is the default runtime factory and legacy remains selectable', () => {
  expect(createEngineFactory()).toBe(createEngineFactory('native'));
  expect(createEngineFactory('spidermonkey-legacy')).not.toBe(createEngineFactory('native'));
  expect(() => createEngineFactory('unknown' as never)).toThrow('Unknown Dusk runtime');
});

test('default ProcessManager engine factory is native', () => {
  const pm = new ProcessManager(createMemoryBackend());
  expect((pm as unknown as { engineFactory: EngineFactory }).engineFactory).toBe(createNativeEngine);
  expect(createEngine).toBe(createNativeEngine);
});

test('one ProcessManager factory creates pid-0, spawn, spawnSync, and worker engines', async () => {
  const pids: number[] = [];
  const funcsByPid = new Map<number, FuncTable>();
  const pm = new ProcessManager(createMemoryBackend(), {}, {}, {
    engineFactory: createRecordingFactory(pids, funcsByPid),
  });
  pm.registerBinary('/bin/exit', 'process.exit(0)');

  await pm.createPidZero({}, () => {});
  await (await pm.spawn('/bin/exit')).exit;
  await pm.spawnSync('/bin/exit');

  const workerSpawn = funcsByPid.get(0)?.['worker.spawn'];
  expect(workerSpawn).toBeTypeOf('function');
  const response = await new Promise<unknown>((resolve) => {
    workerSpawn!({ filename: 'process.exit(0)', evalMode: true, pid: 0 }, (message) => resolve(message));
  });

  expect(response).toMatchObject({ value: { pid: 3 } });
  expect(pids).toEqual([0, 1, 2, 3]);
});
