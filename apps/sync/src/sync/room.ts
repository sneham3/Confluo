import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import type { Logger } from 'pino';
import type { LoadedDoc } from '@confluo/doc-render';
import type { Connection } from '../ws/connection.js';
import type { Metrics } from '../metrics.js';
import type { BufferedUpdate, Persistence } from './persistence.js';

export const FLUSH_INTERVAL_MS = 200;
export const FLUSH_MAX_ITEMS = 64;
export const FLUSH_MAX_BYTES = 512 * 1024;
export const BUFFER_CAP_BYTES = 32 * 1024 * 1024;
export const COMPACT_UPDATES = 500;
export const COMPACT_BYTES = 2 * 1024 * 1024;
export const COMPACT_AGE_MS = 5 * 60_000;

/** In-memory state for one loaded document on this node. */
export class Room {
  readonly ydoc: Y.Doc;
  readonly awareness: awarenessProtocol.Awareness;
  readonly connections = new Set<Connection>();
  lastActivityAt = Date.now();
  unloadTimer: NodeJS.Timeout | null = null;
  unloading = false;
  readonly unsubscribers: Array<() => Promise<void>> = [];

  // persistence bookkeeping
  lastPersistedUpdateId: number;
  updatesSinceSnapshot: number;
  bytesSinceSnapshot: number;
  lastSnapshotAt = Date.now();
  private buffer: BufferedUpdate[] = [];
  private bufferBytes = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;
  private flushAgain = false;
  private retryDelay = 100;
  private compacting: Promise<{ snapshotId: number; byteSize: number } | null> | null = null;

  constructor(
    readonly docId: string,
    loaded: LoadedDoc,
    private readonly persistence: Persistence,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {
    this.ydoc = loaded.ydoc;
    this.awareness = new awarenessProtocol.Awareness(this.ydoc);
    this.awareness.setLocalState(null);
    this.lastPersistedUpdateId = loaded.lastUpdateId;
    this.updatesSinceSnapshot = loaded.updatesSinceSnapshot;
    this.bytesSinceSnapshot = loaded.bytesSinceSnapshot;
  }

  get dirty(): boolean {
    return this.updatesSinceSnapshot > 0 || this.buffer.length > 0;
  }

  get backlogBytes(): number {
    return this.bufferBytes;
  }

  connectionsOf(userId: string): Connection[] {
    const out: Connection[] = [];
    for (const c of this.connections) if (c.userId === userId) out.push(c);
    return out;
  }

  /** Queue an update received directly from a client for durable append. */
  enqueue(update: Uint8Array, originUser: string | null): void {
    this.lastActivityAt = Date.now();
    this.buffer.push({ update, originUser });
    this.bufferBytes += update.byteLength;
    while (this.bufferBytes > BUFFER_CAP_BYTES && this.buffer.length > 1) {
      const dropped = this.buffer.shift()!;
      this.bufferBytes -= dropped.update.byteLength;
      this.logger.error({ docId: this.docId }, 'persist_backlog_overflow: dropping oldest buffered update');
    }
    this.metrics.persistBacklogBytes.inc(update.byteLength);
    if (this.buffer.length >= FLUSH_MAX_ITEMS || this.bufferBytes >= FLUSH_MAX_BYTES) {
      void this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => void this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref?.();
    }
  }

  /** Flush the write buffer. Safe to call concurrently; serialized internally. */
  flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.flushing) {
      this.flushAgain = true;
      return this.flushing;
    }
    if (this.buffer.length === 0) return Promise.resolve();
    this.flushing = this.doFlush().finally(() => {
      this.flushing = null;
      if (this.flushAgain) {
        this.flushAgain = false;
        if (this.buffer.length > 0) void this.flush();
      }
    });
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    const batch = this.buffer;
    const batchBytes = this.bufferBytes;
    this.buffer = [];
    this.bufferBytes = 0;
    try {
      const { maxId, bytes } = await this.persistence.appendUpdates(this.docId, batch);
      this.lastPersistedUpdateId = Math.max(this.lastPersistedUpdateId, maxId);
      this.updatesSinceSnapshot += batch.length;
      this.bytesSinceSnapshot += bytes;
      this.metrics.persistBacklogBytes.dec(batchBytes);
      this.retryDelay = 100;
      void this.maybeCompact();
    } catch (err) {
      // Put the batch back in front and retry with backoff (clients still hold these updates too).
      this.buffer = batch.concat(this.buffer);
      this.bufferBytes += batchBytes;
      this.logger.warn({ docId: this.docId, err, retryInMs: this.retryDelay }, 'persist failed; will retry');
      const delay = this.retryDelay;
      this.retryDelay = Math.min(5000, this.retryDelay * 2);
      this.flushTimer = setTimeout(() => void this.flush(), delay);
      this.flushTimer.unref?.();
    }
  }

  shouldCompact(): boolean {
    if (this.updatesSinceSnapshot >= COMPACT_UPDATES) return true;
    if (this.bytesSinceSnapshot >= COMPACT_BYTES) return true;
    return this.updatesSinceSnapshot > 0 && Date.now() - this.lastSnapshotAt >= COMPACT_AGE_MS;
  }

  async maybeCompact(): Promise<void> {
    if (this.shouldCompact()) await this.compact();
  }

  /** Force a snapshot now (flushes first). */
  compact(): Promise<{ snapshotId: number; byteSize: number } | null> {
    if (this.compacting) return this.compacting;
    this.compacting = (async () => {
      await this.flush();
      const upto = this.lastPersistedUpdateId;
      const res = await this.persistence.compact(this.docId, this.ydoc, upto);
      if (res) {
        this.updatesSinceSnapshot = 0;
        this.bytesSinceSnapshot = 0;
        this.lastSnapshotAt = Date.now();
      }
      return res;
    })().finally(() => {
      this.compacting = null;
    });
    return this.compacting;
  }

  discardBuffer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.metrics.persistBacklogBytes.dec(this.bufferBytes);
    this.buffer = [];
    this.bufferBytes = 0;
  }

  stateBytes(): number {
    return Y.encodeStateAsUpdateV2(this.ydoc).byteLength;
  }

  destroy(): void {
    if (this.unloadTimer) clearTimeout(this.unloadTimer);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
