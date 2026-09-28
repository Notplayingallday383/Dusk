// dsh command bridge for host-backed DPM binaries. Unlike JS binaries, these
// have no source file for just-bash to execute, so invoke ProcessManager over
// the existing synchronous process IPC boundary.
// @ts-nocheck
import type { Command, CommandContext, ExecResult } from '../../../vendor/just-bash/types';

type Ipc = { send: (m: unknown, i?: boolean) => { value?: unknown; error?: string } };

const toBytes = (text: string): number[] => {
  const bytes: number[] = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xff);
  return bytes;
};

const fromBytes = (bytes: number[] | undefined): string => {
  if (!bytes) return '';
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte & 0xff);
  return text;
};

export const dpmCommand = (name: 'dpm' | 'npm' | 'npx' | 'pnpm' | 'dpx'): Command => ({
  name,
  trusted: true,
  async execute(argv: string[], ctx: CommandContext): Promise<ExecResult> {
    const ipc = (globalThis as { ipc?: Ipc }).ipc;
    if (!ipc) return { stdout: '', stderr: `${name}: process bridge unavailable\n`, exitCode: 127 };

    const env: Record<string, string> = {};
    for (const [key, value] of ctx.env.entries()) env[key] = String(value);
    const stdin = String(ctx.stdin ?? '');
    const options: Record<string, unknown> = { cwd: ctx.cwd, env };
    if (stdin.length > 0) options.stdin = toBytes(stdin);

    const response = ipc.send({
      f: 'process.spawnSync',
      command: `/bin/${name}`,
      args: argv,
      options,
    });
    if (response.error) return { stdout: '', stderr: `${name}: ${response.error}\n`, exitCode: 127 };

    const result = response.value as { stdout?: number[]; stderr?: number[]; status?: number } | undefined;
    return {
      stdout: fromBytes(result?.stdout),
      stderr: fromBytes(result?.stderr),
      exitCode: result?.status ?? 1,
    };
  },
});
