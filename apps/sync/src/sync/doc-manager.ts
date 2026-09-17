import { eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { Db } from '@confluo/adapters';
import { documents } from '@confluo/shared/db';
import { loadYDoc } from '@confluo/doc-render';
import type { Metrics } from '../metrics.js';
import type { Persistence } from './persistence.js';
import { Room } from './room.js';

export const UNLOAD_IDLE_MS = 60_000;

export class DocNotFoundError extends Error {
  constructor(docId: string) {
    super(`document ${docId} not found`);
    this.name = 'DocNotFoundError';
  }
}

export interface DocManagerDeps {
  db: Db;
  persistence: Persistence;
  metrics: Metrics;
  logger: Logger;
  maxRssMb: number;
  /** Attach bus subscriptions and doc/awareness listeners. Push unsubscribers onto `room.unsubscribers`. */
  onRoomLoaded(room: Room): Promise<void>;
}

/** Room lifecycle: memoized load, idle unload, memory-pressure eviction (common doc §11.1). */
export class DocManager {
  readonly rooms = new Map<string, Room>();
  private readonly loading = new Map<string, Promise<Room>>();

  constructor(private readonly deps: DocManagerDeps) {}

  async get(docId: string): Promise<Room> {
    const existing = this.rooms.get(docId);
    if (existing && !existing.unloading) {
      this.cancelUnload(existing);
      return existing;
    }
    const inflight = this.loading.get(docId);
    if (inflight) return inflight;
    const p = this.load(docId).finally(() => this.loading.delete(docId));
    this.loading.set(docId, p);
    return p;
  }

  private async load(docId: string): Promise<Room> {
    const { db, persistence, metrics, logger } = this.deps;
    const [row] = await db
      .select({ id: documents.id, deletedAt: documents.deletedAt })
      .from(documents)
      .where(eq(documents.id, docId))
      .limit(1);
    if (!row || row.deletedAt) throw new DocNotFoundError(docId);
    const t0 = Date.now();
    const loaded = await loadYDoc(db, docId);
    const room = new Room(docId, loaded, persistence, metrics, logger);
    await this.deps.onRoomLoaded(room);
    this.rooms.set(docId, room);
    metrics.roomsLoaded.set(this.rooms.size);
    metrics.setDocStateBytes(docId, room.stateBytes());
    logger.info(
      { docId, loadMs: Date.now() - t0, updates: loaded.updatesSinceSnapshot, lastUpdateId: loaded.lastUpdateId },
      'room loaded',
    );
    return room;
  }

  scheduleUnload(room: Room): void {
    if (room.connections.size > 0 || room.unloadTimer || room.unloading) return;
    room.unloadTimer = setTimeout(() => {
      room.unloadTimer = null;
      if (room.connections.size === 0) void this.unload(room, 'idle');
    }, UNLOAD_IDLE_MS);
    room.unloadTimer.unref?.();
  }

  cancelUnload(room: Room): void {
    if (room.unloadTimer) {
      clearTimeout(room.unloadTimer);
      room.unloadTimer = null;
    }
  }

  async unload(room: Room, reason: string, opts?: { discard?: boolean }): Promise<void> {
    if (room.unloading) return;
    room.unloading = true;
    this.cancelUnload(room);
    this.rooms.delete(room.docId);
    const { metrics, logger } = this.deps;
    try {
      if (opts?.discard) {
        room.discardBuffer();
      } else {
        await room.flush();
        if (room.updatesSinceSnapshot > 0) {
          await room.compact().catch((err) => logger.warn({ docId: room.docId, err }, 'compact on unload failed'));
        }
      }
    } finally {
      for (const u of room.unsubscribers.splice(0)) await u().catch(() => undefined);
      room.destroy();
      metrics.roomsLoaded.set(this.rooms.size);
      metrics.removeDoc(room.docId);
      logger.info({ docId: room.docId, reason }, 'room unloaded');
    }
  }

  /** Evict least-recently-active idle rooms while RSS exceeds 80% of the budget. */
  evictIfNeeded(): void {
    const budget = this.deps.maxRssMb * 1024 * 1024 * 0.8;
    if (process.memoryUsage().rss <= budget) return;
    const idle = [...this.rooms.values()]
      .filter((r) => r.connections.size === 0 && !r.unloading)
      .sort((a, b) => a.lastActivityAt - b.lastActivityAt);
    for (const room of idle) {
      void this.unload(room, 'memory-pressure');
      if (process.memoryUsage().rss <= budget) break;
    }
  }

  /** Flush + compact every dirty room, bounded by `timeoutMs`. */
  async closeAll(timeoutMs: number): Promise<void> {
    const work = Promise.all([...this.rooms.values()].map((r) => this.unload(r, 'shutdown')));
    await Promise.race([work, new Promise<void>((res) => setTimeout(res, timeoutMs).unref?.())]);
  }
}
