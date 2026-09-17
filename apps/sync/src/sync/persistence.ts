import { and, eq, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import type * as Y from 'yjs';
import type { Db, KeyValue } from '@confluo/adapters';
import { documentSnapshots, documentUpdates } from '@confluo/shared/db';
import { encodeSnapshot } from '@confluo/doc-render';
import type { Metrics } from '../metrics.js';

export interface BufferedUpdate {
  update: Uint8Array;
  originUser: string | null;
}

export class Persistence {
  constructor(
    private readonly db: Db,
    private readonly kv: KeyValue,
    private readonly nodeId: string,
    private readonly metrics: Metrics,
    private readonly logger: Logger,
  ) {}

  /** Multi-row append. Returns the max inserted id. */
  async appendUpdates(docId: string, batch: BufferedUpdate[]): Promise<{ maxId: number; bytes: number }> {
    if (batch.length === 0) return { maxId: 0, bytes: 0 };
    const end = this.metrics.persistBatchSeconds.startTimer();
    const rows = batch.map((b) => ({
      documentId: docId,
      update: Buffer.from(b.update.buffer, b.update.byteOffset, b.update.byteLength) as unknown as Uint8Array,
      byteSize: b.update.byteLength,
      originUser: b.originUser,
      nodeId: this.nodeId,
    }));
    const inserted = await this.db.insert(documentUpdates).values(rows).returning({ id: documentUpdates.id });
    end();
    let maxId = 0;
    for (const r of inserted) maxId = Math.max(maxId, Number(r.id));
    const bytes = batch.reduce((n, b) => n + b.update.byteLength, 0);
    return { maxId, bytes };
  }

  /**
   * Snapshot compaction (common doc §11.1). Caller must have flushed the write buffer so that
   * `uptoUpdateId` covers everything in `ydoc` that this node persisted.
   */
  async compact(
    docId: string,
    ydoc: Y.Doc,
    uptoUpdateId: number,
  ): Promise<{ snapshotId: number; byteSize: number } | null> {
    const leaseKey = `doc:${docId}:compact`;
    const got = await this.kv.set(leaseKey, this.nodeId, { nx: true, pxMs: 60_000 });
    if (!got) return null;
    const end = this.metrics.compactionSeconds.startTimer();
    try {
      const snap = encodeSnapshot(ydoc);
      const result = await this.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(documentSnapshots)
          .values({
            documentId: docId,
            uptoUpdateId,
            state: Buffer.from(snap.state.buffer, snap.state.byteOffset, snap.state.byteLength) as unknown as Uint8Array,
            stateVector: Buffer.from(
              snap.stateVector.buffer,
              snap.stateVector.byteOffset,
              snap.stateVector.byteLength,
            ) as unknown as Uint8Array,
            byteSize: snap.byteSize,
            charCount: snap.charCount,
          })
          .returning({ id: documentSnapshots.id });
        await tx
          .delete(documentUpdates)
          .where(and(eq(documentUpdates.documentId, docId), lte(documentUpdates.id, uptoUpdateId)));
        return { snapshotId: Number(row!.id), byteSize: snap.byteSize };
      });
      this.metrics.setDocStateBytes(docId, snap.byteSize);
      this.logger.info({ docId, ...result, uptoUpdateId }, 'compacted');
      return result;
    } finally {
      end();
      await this.kv.del(leaseKey).catch(() => undefined);
    }
  }
}
