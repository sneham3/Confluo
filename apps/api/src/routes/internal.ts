import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, TICKET_TTL_SECONDS, type TicketPayload } from '@confluo/shared';
import { documentPermissions, documents, users } from '@confluo/shared/db';
import type { ApiDeps } from '../types.js';
import { requireService } from '../plugins/auth.js';
import { iso } from '../lib/dto.js';
import { randomToken } from '../lib/crypto.js';

export function registerInternalRoutes(app: FastifyInstance, deps: ApiDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, kv } = deps.adapters;

  r.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  r.get('/readyz', { config: { rateLimit: false } }, async () => {
    await db.execute(sql`select 1`);
    return { ok: true, mode: deps.adapters.mode };
  });

  r.post(
    '/internal/tickets',
    { preHandler: [requireService(deps)], schema: { body: z.object({ userId: z.uuid(), docId: z.uuid() }) } },
    async (request) => {
      const { userId, docId } = request.body;
      const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!u) throw new AppError('USER_NOT_FOUND', 404, 'User not found');
      const [doc] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, docId), isNull(documents.deletedAt))).limit(1);
      if (!doc) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
      const [perm] = await db
        .select({ role: documentPermissions.role })
        .from(documentPermissions)
        .where(and(eq(documentPermissions.documentId, docId), eq(documentPermissions.userId, userId)))
        .limit(1);
      if (!perm) throw new AppError('FORBIDDEN', 403, 'User has no access to this document');
      const ticket = randomToken(32);
      const payload: TicketPayload = { userId, docId, role: perm.role, name: u.displayName, color: u.color, iat: Date.now() };
      await kv.set(`ticket:${ticket}`, JSON.stringify(payload), { pxMs: TICKET_TTL_SECONDS * 1000 });
      return { ticket, wsUrl: deps.config.syncUrl, role: perm.role, expiresAt: iso(new Date(Date.now() + TICKET_TTL_SECONDS * 1000)) };
    },
  );

  r.get(
    '/internal/docs/:id/role/:userId',
    { preHandler: [requireService(deps)], schema: { params: z.object({ id: z.uuid(), userId: z.uuid() }) } },
    async (request) => {
      const [doc] = await db.select({ id: documents.id }).from(documents).where(and(eq(documents.id, request.params.id), isNull(documents.deletedAt))).limit(1);
      if (!doc) return { role: null };
      const [perm] = await db
        .select({ role: documentPermissions.role })
        .from(documentPermissions)
        .where(and(eq(documentPermissions.documentId, request.params.id), eq(documentPermissions.userId, request.params.userId)))
        .limit(1);
      return { role: perm?.role ?? null };
    },
  );
}
