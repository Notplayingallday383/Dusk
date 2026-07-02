import { test, expect } from 'vitest';
import { createInitialState } from '../src/shell/scope';

test('ShellState has pipelineGroup field, default null', () => {
  const s = createInitialState();
  expect(s.pipelineGroup).toBe(null);
});

test('pipelineGroup can be set and marked killed', () => {
  const s = createInitialState();
  s.pipelineGroup = { pgid: 1234, killed: false };
  expect(s.pipelineGroup.pgid).toBe(1234);
  s.pipelineGroup.killed = true;
  expect(s.pipelineGroup.killed).toBe(true);
});
