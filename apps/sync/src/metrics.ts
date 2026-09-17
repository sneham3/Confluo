import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

export class Metrics {
  readonly registry = new Registry();
  readonly roomsLoaded = new Gauge({ name: 'rooms_loaded', help: 'Rooms in memory', registers: [this.registry] });
  readonly connections = new Gauge({
    name: 'connections',
    help: 'Open sockets',
    labelNames: ['role'],
    registers: [this.registry],
  });
  readonly gateDropped = new Counter({
    name: 'sync_gate_dropped_total',
    help: 'Frames dropped by the permission gate',
    labelNames: ['role', 'type'],
    registers: [this.registry],
  });
  readonly updateBytes = new Counter({
    name: 'sync_update_bytes_total',
    help: 'Bytes of Yjs updates received from clients',
    registers: [this.registry],
  });
  readonly persistBatchSeconds = new Histogram({
    name: 'persist_batch_seconds',
    help: 'Write buffer flush latency',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [this.registry],
  });
  readonly persistBacklogBytes = new Gauge({
    name: 'persist_backlog_bytes',
    help: 'Unflushed update bytes across rooms',
    registers: [this.registry],
  });
  readonly compactionSeconds = new Histogram({
    name: 'compaction_seconds',
    help: 'Snapshot compaction latency',
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });
  readonly docStateBytes = new Gauge({
    name: 'doc_state_bytes',
    help: 'Encoded V2 state size per loaded doc (top 50)',
    labelNames: ['docId'],
    registers: [this.registry],
  });
  readonly awarenessUpdates = new Counter({
    name: 'awareness_updates_total',
    help: 'Awareness frames received',
    registers: [this.registry],
  });
  readonly rpcSeconds = new Histogram({
    name: 'rpc_seconds',
    help: 'RPC handler latency',
    labelNames: ['method'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5],
    registers: [this.registry],
  });
  readonly lockAcquire = new Counter({
    name: 'lock_acquire_total',
    help: 'Lock acquire attempts',
    labelNames: ['granted'],
    registers: [this.registry],
  });

  private readonly docLabels = new Set<string>();

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }

  setDocStateBytes(docId: string, bytes: number) {
    if (!this.docLabels.has(docId)) {
      if (this.docLabels.size >= 50) return;
      this.docLabels.add(docId);
    }
    this.docStateBytes.set({ docId }, bytes);
  }

  removeDoc(docId: string) {
    if (this.docLabels.delete(docId)) this.docStateBytes.remove({ docId });
  }

  text() {
    return this.registry.metrics();
  }
}
