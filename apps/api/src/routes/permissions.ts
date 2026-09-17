import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  AppError,
  CreateShareLinkBody,
  LookupQuery,
  SetPermissionBody,
  maxRole,
  type Role,
} from '@confluo/shared';
import { documentPermissions, documents, shareLinks, users } from '@confluo/shared/db';
import type { ApiDeps } from '../types.js';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import { publishDocEvent } from '../services/events.js';
import { invalidateRole } from '../services/roles.js';
import { iso, toUserPublic } from '../lib/dto.js';
import { randomToken, sha256 } from '../lib/crypto.js';

const IdParams = z.object({ id: z.uuid() });
const IdUserParams = z.object({ id: z.uuid(), userId: z.uuid() });
const IdLinkParams = z.object({ id: z.uuid(), linkId: z.uuid() });

export function registerPermissionRoutes(app: FastifyInstance, deps: ApiDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, pubsub } = deps.adapters;

  r.get('/docs/:id/permissions', { preHandler: [requireRole(deps, 'owner')], schema: { params: IdParams } }, async (request) => {
    const rows = await db
      .select({ user: users, role: documentPermissions.role, grantedBy: documentPermissions.grantedBy, createdAt: documentPermissions.createdAt })
      .from(documentPermissions)
      .innerJoin(users, eq(users.id, documentPermissions.userId))
      .where(eq(documentPermissions.documentId, request.params.id));
    return {
      items: rows.map((row) => ({
        user: toUserPublic(row.user),
        role: row.role,
        grantedBy: row.grantedBy,
        createdAt: iso(row.createdAt),
      })),
    };
  });

  r.put(
    '/docs/:id/permissions/:userId',
    { preHandler: [requireRole(deps, 'owner')], schema: { params: IdUserParams, body: SetPermissionBody } },
    async (request) => {
      const { id: docId, userId } = request.params;
      const [doc] = await db.select({ ownerId: documents.ownerId }).from(documents).where(eq(documents.id, docId)).limit(1);
      if (!doc) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
      if (doc.ownerId === userId) throw new AppError('VALIDATION_FAILED', 400, "The owner's permission cannot be changed");
      const [target] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
      if (!target) throw new AppError('USER_NOT_FOUND', 404, 'User not found');
      const [row] = await db
        .insert(documentPermissions)
        .values({ documentId: docId, userId, role: request.body.role, grantedBy: request.user!.id })
        .onConflictDoUpdate({
          target: [documentPermissions.documentId, documentPermissions.userId],
          set: { role: request.body.role, grantedBy: request.user!.id },
        })
        .returning();
      await invalidateRole(deps.adapters, docId, userId);
      await publishDocEvent(pubsub, docId, { type: 'permission.changed', payload: { userId, role: request.body.role } });
      await audit(db, {
        actorId: request.user!.id,
        action: 'perm.set',
        targetType: 'document',
        targetId: docId,
        metadata: { userId, role: request.body.role },
        ip: request.ip,
      });
      return {
        item: { user: toUserPublic(target), role: row!.role, grantedBy: row!.grantedBy, createdAt: iso(row!.createdAt) },
      };
    },
  );

  r.delete(
    '/docs/:id/permissions/:userId',
    { preHandler: [requireRole(deps, 'owner')], schema: { params: IdUserParams } },
    async (request, reply) => {
      const { id: docId, userId } = request.params;
      const [doc] = await db.select({ ownerId: documents.ownerId }).from(documents).where(eq(documents.id, docId)).limit(1);
      if (!doc) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
      if (doc.ownerId === userId) throw new AppError('VALIDATION_FAILED', 400, "The owner's permission cannot be removed");
      await db
        .delete(documentPermissions)
        .where(and(eq(documentPermissions.documentId, docId), eq(documentPermissions.userId, userId)));
      await invalidateRole(deps.adapters, docId, userId);
      await publishDocEvent(pubsub, docId, { type: 'permission.changed', payload: { userId, role: null } });
      await audit(db, { actorId: request.user!.id, action: 'perm.remove', targetType: 'document', targetId: docId, metadata: { userId }, ip: request.ip });
      reply.status(204);
      return null;
    },
  );

  r.post(
    '/docs/:id/share-links',
    { preHandler: [requireRole(deps, 'owner')], schema: { params: IdParams, body: CreateShareLinkBody } },
    async (request, reply) => {
      const raw = randomToken(32);
      const expiresAt = request.body.expiresInHours
        ? new Date(Date.now() + request.body.expiresInHours * 3600_000)
        : null;
      const [row] = await db
        .insert(shareLinks)
        .values({
          documentId: request.params.id,
          role: request.body.role,
          tokenHash: sha256(raw),
          createdBy: request.user!.id,
          expiresAt,
        })
        .returning();
      await audit(db, { actorId: request.user!.id, action: 'share.create', targetType: 'document', targetId: request.params.id, metadata: { role: request.body.role }, ip: request.ip });
      reply.status(201);
      return {
        id: row!.id,
        role: row!.role,
        url: `${deps.config.webUrl}/share/${raw}`,
        expiresAt: row!.expiresAt ? iso(row!.expiresAt) : null,
        createdAt: iso(row!.createdAt),
      };
    },
  );

  r.get('/docs/:id/share-links', { preHandler: [requireRole(deps, 'owner')], schema: { params: IdParams } }, async (request) => {
    const rows = await db
      .select()
      .from(shareLinks)
      .where(and(eq(shareLinks.documentId, request.params.id), isNull(shareLinks.revokedAt)))
      .orderBy(desc(shareLinks.createdAt));
    return {
      items: rows.map((row) => ({
        id: row.id,
        role: row.role,
        expiresAt: row.expiresAt ? iso(row.expiresAt) : null,
        createdAt: iso(row.createdAt),
      })),
    };
  });

  r.delete(
    '/docs/:id/share-links/:linkId',
    { preHandler: [requireRole(deps, 'owner')], schema: { params: IdLinkParams } },
    async (request, reply) => {
      await db
        .update(shareLinks)
        .set({ revokedAt: new Date() })
        .where(and(eq(shareLinks.id, request.params.linkId), eq(shareLinks.documentId, request.params.id)));
      await audit(db, { actorId: request.user!.id, action: 'share.revoke', targetType: 'document', targetId: request.params.id, metadata: { linkId: request.params.linkId }, ip: request.ip });
      reply.status(204);
      return null;
    },
  );

  r.post(
    '/share/:token/accept',
    { preHandler: [requireAuth], schema: { params: z.object({ token: z.string().min(10).max(200) }) } },
    async (request) => {
      const [link] = await db.select().from(shareLinks).where(eq(shareLinks.tokenHash, sha256(request.params.token))).limit(1);
      if (!link || link.revokedAt || (link.expiresAt && link.expiresAt.getTime() < Date.now())) {
        throw new AppError('NOT_FOUND', 404, 'This share link is invalid or has expired');
      }
      const [doc] = await db.select().from(documents).where(and(eq(documents.id, link.documentId), isNull(documents.deletedAt))).limit(1);
      if (!doc) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
      const userId = request.user!.id;
      const [existing] = await db
        .select({ role: documentPermissions.role })
        .from(documentPermissions)
        .where(and(eq(documentPermissions.documentId, doc.id), eq(documentPermissions.userId, userId)))
        .limit(1);
      const role = maxRole(existing?.role ?? null, link.role) as Role;
      if (!existing || existing.role !== role) {
        await db
          .insert(documentPermissions)
          .values({ documentId: doc.id, userId, role, grantedBy: link.createdBy })
          .onConflictDoUpdate({
            target: [documentPermissions.documentId, documentPermissions.userId],
            set: { role },
          });
        await invalidateRole(deps.adapters, doc.id, userId);
        await publishDocEvent(pubsub, doc.id, { type: 'permission.changed', payload: { userId, role } });
      }
      await audit(db, { actorId: userId, action: 'share.accept', targetType: 'document', targetId: doc.id, metadata: { role }, ip: request.ip });
      return { docId: doc.id, role };
    },
  );

  r.get(
    '/users/lookup',
    {
      preHandler: [requireAuth],
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      schema: { querystring: LookupQuery },
    },
    async (request) => {
      const [u] = await db.select().from(users).where(eq(users.email, request.query.email.trim().toLowerCase())).limit(1);
      if (!u) throw new AppError('USER_NOT_FOUND', 404, 'No account with that email');
      return { user: { id: u.id, name: u.displayName, color: u.color } };
    },
  );
}
