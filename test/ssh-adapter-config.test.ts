import { expect, test } from 'vitest';
import { ProcessManager } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';

test('ProcessManager has no SSH host adapter or injected guest global', async () => {
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, {
    relay: { attach: () => new MessageChannel().port1 },
    ssh: {
      adapter: { register: ({ registerSsh }: { registerSsh(binary: Parameters<ProcessManager['registerStreamingHostBinary']>[1]): void }) => registerSsh(() => ({ exit: Promise.resolve(0), kill: () => {} })) },
      hostKeyVerification: { hostKeyFingerprint: 'SHA256:server-key' },
      wasm: { wasmPath: '/assets/lunassh.wasm', wasmExecPath: '/assets/wasm_exec.js' },
    },
  } as never);

  expect(manager.hasBinary('/bin/ssh')).toBe(false);
  await expect((manager as unknown as { buildEntry(cmd: string, args: string[], env: Record<string, string>, cwd: string): Promise<string> })
    .buildEntry('/project/node_modules/ssh/dist/bin.js', [], {}, '/project')).resolves.not.toContain('__duskSsh');
});
