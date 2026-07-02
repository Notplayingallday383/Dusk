import { createEngine, type FuncTable } from './engine-instance';

export { createEngine, type EngineInstance, type SendFn, type FuncFn, type FuncTable } from './engine-instance';

export interface DuskRunner {
  run(js: string): Promise<void>;
  dispatch(js: string): void;
  stop(): void;
}

export const createRunner = async (funcs: FuncTable = {}): Promise<DuskRunner> => {
  const engine = await createEngine(0, funcs);
  return {
    run: (js) => engine.run(js),
    dispatch: (js) => engine.dispatch(js),
    stop: () => { void engine.terminate(); },
  };
};
