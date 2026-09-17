import { and, eq, isNull } from 'drizzle-orm';
import { AppError, RoleSchema, isAtLeast, type Role } from '@confluo/shared';
import { documentPermissions, documents } from '@confluo/shared/db';
import type { Adapters } from '@confluo/adapters';

const ROLE_CACHE_MS = 5000;

/** Returns the user's role on a live document, or null when no permission. Throws 404 when the doc is missing/deleted. */
export async function getRole(adapters: Adapters, docId: string, userId: string): Promise<Role | null> {
  const cacheKey = `role:${docId}:${userId}`;
  const cached = await adapters.kv.get(cacheKey);
  if (cached !== null) {
    if (cached === '404') throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
    if (cached === 'none') return null;
    const parsed = RoleSchema.safeParse(cached);
    if (parsed.success) return parsed.data;
  }
  const [doc] = await adapters.db
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.id, docId), isNull(documents.deletedAt)))
    .limit(1);
  if (!doc) {
    await adapters.kv.set(cacheKey, '404', { pxMs: ROLE_CACHE_MS });
    throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
  }
  const [perm] = await adapters.db
    .select({ role: documentPermissions.role })
    .from(documentPermissions)
    .where(and(eq(documentPermissions.documentId, docId), eq(documentPermissions.userId, userId)))
    .limit(1);
  const role = perm?.role ?? null;
  await adapters.kv.set(cacheKey, role ?? 'none', { pxMs: ROLE_CACHE_MS });
  return role;
}

export async function requireRoleOn(
  adapters: Adapters,
  docId: string,
  userId: string,
  min: Role,
): Promise<Role> {
  const role = await getRole(adapters, docId, userId);
  if (!isAtLeast(role, min)) {
    // Hide existence from users with no access at all.
    if (!role) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
    throw new AppError('FORBIDDEN', 403, `Requires ${min} access`);
  }
  return role as Role;
}

export async function invalidateRole(adapters: Adapters, docId: string, userId?: string): Promise<void> {
  if (userId) {
    await adapters.kv.del(`role:${docId}:${userId}`);
    return;
  }
  // No key scan in our KV abstraction: callers pass the affected user ids explicitly.
}
