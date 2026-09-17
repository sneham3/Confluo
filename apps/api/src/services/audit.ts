import { auditLog } from '@confluo/shared/db';
import type { Db } from '@confluo/adapters';

export async function audit(
  db: Db,
  entry: {
    actorId: string | null;
    action: string;
    targetType: string;
    targetId: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
  },
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      actorId: entry.actorId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata ?? {},
      ip: entry.ip ?? null,
    });
  } catch {
    /* audit must never break a request */
  }
}
