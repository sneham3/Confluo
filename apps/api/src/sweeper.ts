import { and, eq, lt } from 'drizzle-orm';
import { assets } from '@confluo/shared/db';
import { loadYDoc, referencedAssetIds } from '@confluo/doc-render';
import type { ApiDeps } from './types.js';

/**
 * Orphan sweeper (common doc / Dev 4 §4.5): pending uploads older than 1 h are removed;
 * ready assets no longer referenced by their document for > 24 h are marked orphaned.
 */
export async function sweepOrphanAssets(deps: ApiDeps): Promise<{ deletedPending: number; orphaned: number }> {
  const { db, storage } = deps.adapters;
  const hourAgo = new Date(Date.now() - 3600_000);
  const dayAgo = new Date(Date.now() - 24 * 3600_000);

  const pending = await db
    .select()
    .from(assets)
    .where(and(eq(assets.status, 'pending'), lt(assets.createdAt, hourAgo)));
  for (const a of pending) {
    await storage.delete(a.storageKey).catch(() => undefined);
    await db.delete(assets).where(eq(assets.id, a.id));
  }

  const ready = await db
    .select()
    .from(assets)
    .where(and(eq(assets.status, 'ready'), lt(assets.createdAt, dayAgo)));
  const byDoc = new Map<string, typeof ready>();
  for (const a of ready) {
    const list = byDoc.get(a.documentId) ?? [];
    list.push(a);
    byDoc.set(a.documentId, list);
  }
  let orphaned = 0;
  for (const [docId, list] of byDoc) {
    let referenced: Set<string>;
    try {
      const loaded = await loadYDoc(db, docId);
      referenced = referencedAssetIds(loaded.ydoc);
      loaded.ydoc.destroy();
    } catch (err) {
      deps.logger.warn({ err, docId }, 'sweeper: could not load doc');
      continue;
    }
    for (const a of list) {
      if (!referenced.has(a.id)) {
        await db.update(assets).set({ status: 'orphaned' }).where(eq(assets.id, a.id));
        orphaned++;
      }
    }
  }
  return { deletedPending: pending.length, orphaned };
}
