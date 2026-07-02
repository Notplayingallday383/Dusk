// Concurrent shell pipeline runner.
//
// Stages run in parallel via Promise.all over bounded async byte channels
// (see pipe-channel.ts). Backpressure comes from the channel's capacity
// (4 chunks). When a downstream stage exits, its input channel's reader
// is closed; the next upstream write rejects with code 'EPIPE', which
// streaming builtins translate into exit code 141 (the POSIX SIGPIPE
// convention). This is the in-process equivalent of SIGPIPE delivery.
//
// Cross-engine SIGPIPE (when stages run in separate worker engines via
// ProcessManager) is OUT OF SCOPE here. The integration point is:
//   1) Replace `createPipeChannel` calls with `streamRegistry.create()` +
//      `streamRegistry.bridge()` calls (see stream-events spec).
//   2) Register `streamRegistry.onSinkClosed(stdinId, () =>
//      processManager.signal(stagePid, 'SIGPIPE'))` after spawn.
//   3) Replace the in-process streaming-builtin fast path with worker
//      spawn via processManager.spawn(...) using the pre-allocated
//      stream ids for stdio.
// Foreground pgid designation (repl.foregroundPgid = pgid) and Ctrl+C
// group-send wiring also live there, not here.
//
// The `state.pipelineGroup.pgid` field is populated on every pipeline run
// even in this in-process mode so callers that DO have signal-delivery
// hooks (e.g. a future REPL Ctrl+C handler that walks live pipelines and
// sets `state.pipelineGroup.killed = true`, then closes all channels)
// can plug in without further runner changes.
//
// Non-streaming stages are wrapped in a buffering adapter that drains its
// upstream fully, runs, then writes the captured stdout to its downstream
// and closes.

import type { AnyCmd, Pipeline, SimpleCommand } from './ast';
import { createPipeChannel, type PipeChannel } from './pipe-channel';
import { streamingBuiltins, type StreamingBuiltinIo } from './streaming-builtins';
import type { ShellState } from './scope';
import { expandWord } from './expander';

type ExecuteCommand = (node: AnyCmd, state: ShellState, io: IoContextLike) => Promise<{ status: number }>;
type RunCmdsub = (script: string) => Promise<string>;

interface CaptureBuffer {
  stdout: Uint8Array[];
  stderr: Uint8Array[];
}

interface IoContextLike {
  stdin: Uint8Array;
  captureStdout?: CaptureBuffer;
  captureStderr?: CaptureBuffer;
}

const CHANNEL_CAPACITY = 4;
let nextPgid = 1;

const drainChannel = async (ch: PipeChannel): Promise<Uint8Array> => {
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const c of ch.readable) { parts.push(c); total += c.length; }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
};

// Best-effort: peek at a SimpleCommand's resolved command name to decide whether
// to take the streaming-builtin fast path. Expands word[0] only.
const resolveCommandName = async (
  stage: SimpleCommand, state: ShellState, runCmdsub: RunCmdsub,
): Promise<string | null> => {
  if (stage.kind !== 'simple' || stage.words.length === 0) return null;
  try {
    const expanded = await expandWord(stage.words[0]!, state, { runCmdsub });
    return expanded[0] ?? null;
  } catch { return null; }
};

interface RunPipelineDeps {
  executeCommand: ExecuteCommand;
  runCmdsub: (state: ShellState) => RunCmdsub;
}

export const runConcurrentPipeline = async (
  node: Pipeline, state: ShellState, io: IoContextLike, deps: RunPipelineDeps,
): Promise<{ status: number }> => {
  if (node.stages.length === 1) {
    await deps.executeCommand(node.stages[0]!, state, io);
    if (node.negated) state.exitCode = state.exitCode === 0 ? 1 : 0;
    return { status: state.exitCode };
  }

  const N = node.stages.length;
  // channels[i] sits between stage i and stage i+1.
  const channels: PipeChannel[] = [];
  for (let i = 0; i < N - 1; i++) channels.push(createPipeChannel(CHANNEL_CAPACITY));

  const pgid = nextPgid++;
  const prevGroup = state.pipelineGroup;
  state.pipelineGroup = { pgid, killed: false };
  (state as ShellState & { _lastPipelineGroupPgid?: number })._lastPipelineGroupPgid = pgid;

  const runCmdsub = deps.runCmdsub(state);

  const runStage = async (i: number): Promise<number> => {
    const stage = node.stages[i]!;
    const inputChannel = i === 0 ? null : channels[i - 1]!;
    const outputChannel = i === N - 1 ? null : channels[i]!;

    // 1) Streaming fast path for known streaming builtins on SimpleCommands.
    const cmdName = stage.kind === 'simple'
      ? await resolveCommandName(stage as SimpleCommand, state, runCmdsub)
      : null;
    const sbuiltin = cmdName ? streamingBuiltins[cmdName] : undefined;

    if (sbuiltin && stage.kind === 'simple') {
      // Expand arg words (skip word[0]).
      const simple = stage as SimpleCommand;
      const expanded: string[] = [];
      for (let k = 1; k < simple.words.length; k++) {
        const items = await expandWord(simple.words[k]!, state, { runCmdsub });
        for (const it of items) expanded.push(it);
      }
      const stdinStream: AsyncIterable<Uint8Array> = inputChannel
        ? inputChannel.readable
        : (async function* (): AsyncIterable<Uint8Array> {
            if (io.stdin.length > 0) yield io.stdin;
          })();
      const writeStdout = async (chunk: Uint8Array): Promise<void> => {
        if (outputChannel) {
          await outputChannel.write(chunk);
        } else if (io.captureStdout) {
          io.captureStdout.stdout.push(chunk);
        } else {
          const proc = (globalThis as Record<string, unknown>)['process'] as
            { stdout?: { write: (d: Uint8Array) => void } } | undefined;
          if (proc?.stdout) proc.stdout.write(chunk);
        }
      };
      const writeStderr = async (chunk: Uint8Array): Promise<void> => {
        if (io.captureStderr) {
          io.captureStderr.stderr.push(chunk);
        } else {
          const proc = (globalThis as Record<string, unknown>)['process'] as
            { stderr?: { write: (d: Uint8Array) => void } } | undefined;
          if (proc?.stderr) proc.stderr.write(chunk);
        }
      };
      const sio: StreamingBuiltinIo = {
        stdinStream, writeStdout, writeStderr,
        signalEof: () => { if (outputChannel) outputChannel.close(); },
      };
      let status: number;
      try {
        status = await sbuiltin(expanded, state, sio);
      } finally {
        if (outputChannel) outputChannel.close();
        if (inputChannel) inputChannel.closeReader();
      }
      return status;
    }

    // 2) Fallback: drain input, run non-streaming, push captured output to
    //    downstream channel, then close.
    const stdinBytes = inputChannel ? await drainChannel(inputChannel) : io.stdin;
    const captureStdout: CaptureBuffer | undefined = outputChannel
      ? { stdout: [], stderr: [] }
      : io.captureStdout;
    const stageIo: IoContextLike = {
      stdin: stdinBytes,
      ...(captureStdout ? { captureStdout } : {}),
      ...(io.captureStderr ? { captureStderr: io.captureStderr } : {}),
    };
    let status: number;
    try {
      const res = await deps.executeCommand(stage, state, stageIo);
      status = res.status;
    } finally {
      if (outputChannel) {
        try {
          for (const chunk of captureStdout?.stdout ?? []) {
            try {
              await outputChannel.write(chunk);
            } catch (e) {
              if ((e as { code?: string }).code === 'EPIPE') { status = 141; break; }
              throw e;
            }
          }
        } finally {
          outputChannel.close();
        }
      }
    }
    return status;
  };

  const statuses = await Promise.all(node.stages.map((_, i) => runStage(i)));
  state.pipeStatus = statuses;
  if (state.setOptions.pipefail) {
    const firstFail = statuses.find((s) => s !== 0);
    state.exitCode = firstFail !== undefined ? firstFail : 0;
  } else {
    state.exitCode = statuses[statuses.length - 1] ?? 0;
  }
  if (node.negated) state.exitCode = state.exitCode === 0 ? 1 : 0;
  state.pipelineGroup = prevGroup;
  return { status: state.exitCode };
};
