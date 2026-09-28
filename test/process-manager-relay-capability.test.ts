import { expect, test, vi } from 'vitest';
import { ProcessManager, type RelayListener, type RelaySocket } from '../src/host/process-manager';
import { createMemoryBackend } from '../src/host/fs-backend';
import type { DuskRelayCapability, MoonbeamAttachableRelay } from '../src/index';

class AttachRelay implements RelayListener {
  readonly attachments: Array<{ label?: string }> = [];
  listenerRegistrations = 0;
  listenerDisposals = 0;
  authorizeListen = (): boolean => true;

  registerListener(_host: string, _port: number, _handler: (socket: RelaySocket) => void): () => void {
    this.listenerRegistrations++;
    return () => { this.listenerDisposals++; };
  }

  attach(metadata: { label?: string } = {}): MessagePort {
    this.attachments.push(metadata);
    return new MessageChannel().port1;
  }
}

test('ProcessManager relay capability attaches through the configured relay', () => {
  const relay = new AttachRelay();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { relay });

  const configuredRelay: MoonbeamAttachableRelay = relay;
  const capability: DuskRelayCapability = manager.relayCapability();
  const port = capability.attach({ label: 'lunassh' });

  expect(configuredRelay).toBe(relay);
  expect(port).toBeInstanceOf(MessagePort);
  expect(relay.attachments).toEqual([{ label: 'lunassh' }]);
});

test('ProcessManager relay capability is invalidated when its relay is replaced', () => {
  const first = new AttachRelay();
  const second = new AttachRelay();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { relay: first });
  const capability = manager.relayCapability();

  manager.setRelay(second);

  expect(() => capability.attach()).toThrow('Dusk relay capability is no longer active');
  expect(first.attachments).toEqual([]);
});

test('ProcessManager relay capability is invalidated when the manager closes', () => {
  const relay = new AttachRelay();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { relay });
  const capability = manager.relayCapability();

  manager.close();

  expect(() => capability.attach()).toThrow('Dusk relay capability is no longer active');
  expect(relay.attachments).toEqual([]);
});

test('guest net.connect remains loopback-only when an attach-capable relay is configured', () => {
  const relay = new AttachRelay();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { relay });
  const funcs = (manager as unknown as {
    buildFuncs(pid: number): Record<string, (message: Record<string, unknown>, send: (response: { value?: unknown; error?: string }) => void) => void>;
  }).buildFuncs(0);
  let response: { value?: unknown; error?: string } | undefined;

  funcs['net.connect']!({ host: 'ssh.example.test', port: 22 }, (reply) => { response = reply; });

  expect(response).toEqual({ error: 'ECONNREFUSED: connect ssh.example.test:22' });
  expect(relay.attachments).toEqual([]);
});

test('guest net.connect delegates non-loopback TCP to Dusk configured networking', () => {
  const open = vi.fn((message, send) => send({ value: { socketId: 91, remoteAddress: message.host, remotePort: message.port } }));
  const manager = new ProcessManager(createMemoryBackend(), { 'net.tcp.open': open });
  const funcs = (manager as unknown as {
    buildFuncs(pid: number): Record<string, (message: Record<string, unknown>, send: (response: { value?: unknown; error?: string }) => void) => void>;
  }).buildFuncs(7);
  let response: { value?: unknown; error?: string } | undefined;

  funcs['net.connect']!({ host: 'ssh.example.test', port: 22 }, (reply) => { response = reply; });

  expect(open).toHaveBeenCalledWith(expect.objectContaining({ host: 'ssh.example.test', port: 22, pid: 7 }), expect.any(Function));
  expect(response).toEqual({ value: { socketId: 91, remoteAddress: 'ssh.example.test', remotePort: 22 } });
});

test('ProcessManager close releases Dusk relay listener registrations', () => {
  const relay = new AttachRelay();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { relay });
  const funcs = (manager as unknown as {
    buildFuncs(pid: number): Record<string, (message: Record<string, unknown>, send: (response: { value?: unknown; error?: string }) => void) => void>;
  }).buildFuncs(0);

  let response: { value?: unknown; error?: string } | undefined;
  funcs['net.listen']!({ host: 'dusk.public', port: 8022 }, (reply) => { response = reply; });
  expect(response).toEqual({ value: { serverId: 1, address: 'dusk.public', port: 8022 } });
  expect(relay.listenerRegistrations).toBe(1);
  manager.close();

  expect(relay.listenerDisposals).toBe(1);
});

test('ProcessManager relay replacement releases registrations owned by the previous relay', () => {
  const first = new AttachRelay();
  const second = new AttachRelay();
  const manager = new ProcessManager(createMemoryBackend(), {}, {}, { relay: first });
  const funcs = (manager as unknown as {
    buildFuncs(pid: number): Record<string, (message: Record<string, unknown>, send: (response: { value?: unknown; error?: string }) => void) => void>;
  }).buildFuncs(0);

  funcs['net.listen']!({ host: 'dusk.public', port: 8022 }, () => {});
  manager.setRelay(second);

  expect(first.listenerDisposals).toBe(1);
});
