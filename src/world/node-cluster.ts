// node:cluster — stub. No real cluster IPC.
// Most code does `if (cluster.isPrimary) { ... } else { ... }` — both branches
// can take the primary path here. Workers are NOT supported.

import { EventEmitter } from './node-events';

class Cluster extends EventEmitter {
  readonly isPrimary = true;
  readonly isMaster = true;        // deprecated alias
  readonly isWorker = false;
  readonly worker: undefined = undefined;
  readonly workers: Record<string, unknown> = {};
  schedulingPolicy: number = 2;
  settings: Record<string, unknown> = {};

  SCHED_NONE = 1;
  SCHED_RR = 2;

  setupPrimary(opts?: Record<string, unknown>): void {
    if (opts) Object.assign(this.settings, opts);
    this.emit('setup', this.settings);
  }
  setupMaster = this.setupPrimary;

  fork(_env?: Record<string, string>): unknown {
    const err = new Error('cluster.fork() is not supported in DuskJS; cluster has no worker mode');
    (err as Error & { code?: string }).code = 'ERR_UNSUPPORTED';
    throw err;
  }

  disconnect(_cb?: () => void): void { /* no-op */ }
}

const _cluster = new Cluster();

export const nodeCluster = _cluster;

export const default_ = _cluster;
