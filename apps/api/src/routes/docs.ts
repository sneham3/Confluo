import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  AppError,
  ContentQuery,
  CreateDocBody,
  DocListQuery,
  PatchDocBody,
  RoleRank,
  TICKET_TTL_SECONDS,
  type Collaborator,
  type DocSummary,
  type TicketPayload,
} from '@confluo/shared';
import { documentPermissions, documentSnapshots, documents, users } from '@confluo/shared/db';
import { createInitialDoc, encodeSnapshot, loadYDoc, toHTML, toProseMirrorJSON, toText } from '@confluo/doc-render';
import type { ApiDeps } from '../types.js';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { audit } from '../services/audit.js';
import { publishDocEvent } from '../services/events.js';
import { iso, toDoc, toUserPublic } from '../lib/dto.js';
import { randomToken } from '../lib/crypto.js';

const IdParams = z.object({ id: z.uuid() });

function encodeCursor(updatedAt: Date, id: string) {
  return Buffer.from(`${updatedAt.toISOString()}|${id}`).toString('base64url');
}
function decodeCursor(c: string): { updatedAt: Date; id: string } | null {
  try {
    const [ts, id] = Buffer.from(c, 'base64url').toString().split('|');
    if (!ts || !id) return null;
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return null;
    return { updatedAt: d, id };
  } catch {
    return null;
  }
}

export function registerDocRoutes(app: FastifyInstance, deps: ApiDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, kv, pubsub } = deps.adapters;

  r.post('/docs', { preHandler: [requireAuth], schema: { body: CreateDocBody } }, async (request, reply) => {
    const userId = request.user!.id;
    const title = request.body.title?.trim() || 'Untitled';
    const doc = await db.transaction(async (tx) => {
      const [d] = await tx.insert(documents).values({ title, ownerId: userId }).returning();
      await tx.insert(documentPermissions).values({
        documentId: d!.id,
        userId,
        role: 'owner',
        grantedBy: userId,
      });
      const snap = encodeSnapshot(createInitialDoc(d!.id));
      await tx.insert(documentSnapshots).values({
        documentId: d!.id,
        uptoUpdateId: 0,
        state: snap.state,
        stateVector: snap.stateVector,
        byteSize: snap.byteSize,
        charCount: snap.charCount,
      });
      return d!;
    });
    await audit(db, { actorId: userId, action: 'doc.create', targetType: 'document', targetId: doc.id, ip: request.ip });
    reply.status(201);
    return { doc: toDoc(doc) };
  });

  r.get('/docs', { preHandler: [requireAuth], schema: { querystring: DocListQuery } }, async (request) => {
    const userId = request.user!.id;
    const { limit } = request.query;
    const cursor = request.query.cursor ? decodeCursor(request.query.cursor) : null;
    if (request.query.cursor && !cursor) throw new AppError('VALIDATION_FAILED', 400, 'Invalid cursor');

    const rows = await db
      .select({ doc: documents, role: documentPermissions.role })
      .from(documentPermissions)
      .innerJoin(documents, eq(documents.id, documentPermissions.documentId))
      .where(
        and(
          eq(documentPermissions.userId, userId),
          isNull(documents.deletedAt),
          cursor
            ? or(
                lt(documents.updatedAt, cursor.updatedAt),
                and(eq(documents.updatedAt, cursor.updatedAt), lt(documents.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(documents.updatedAt), desc(documents.id))
      .limit(limit + 1);

    const page = rows.slice(0, limit);
    const ids = page.map((p) => p.doc.id);
    const counts = ids.length
      ? await db
          .select({ documentId: documentPermissions.documentId, n: count() })
          .from(documentPermissions)
          .where(inArray(documentPermissions.documentId, ids))
          .groupBy(documentPermissions.documentId)
      : [];
    const countMap = new Map(counts.map((c) => [c.documentId, Number(c.n)]));
    const items: DocSummary[] = page.map((p) => ({
      ...toDoc(p.doc),
      role: p.role,
      collaboratorCount: countMap.get(p.doc.id) ?? 1,
    }));
    const last = page[page.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last.doc.updatedAt, last.doc.id) : null;
    return { items, nextCursor };
  });

  r.get('/docs/:id', { preHandler: [requireRole(deps, 'viewer')], schema: { params: IdParams } }, async (request) => {
    const [doc] = await db.select().from(documents).where(eq(documents.id, request.params.id)).limit(1);
    if (!doc || doc.deletedAt) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
    const collabRows = await db
      .select({ user: users, role: documentPermissions.role })
      .from(documentPermissions)
      .innerJoin(users, eq(users.id, documentPermissions.userId))
      .where(eq(documentPermissions.documentId, doc.id))
      .limit(50);
    const collaborators: Collaborator[] = collabRows
      .map((c) => ({ ...toUserPublic(c.user), role: c.role }))
      .sort((a, b) => RoleRank[b.role] - RoleRank[a.role] || a.name.localeCompare(b.name));
    return { doc: toDoc(doc), role: request.docRole!, collaborators };
  });

  r.get(
    '/docs/:id/content',
    { preHandler: [requireRole(deps, 'viewer')], schema: { params: IdParams, querystring: ContentQuery } },
    async (request, reply) => {
      const loaded = await loadYDoc(db, request.params.id);
      const format = request.query.format;
      const content =
        format === 'html' ? toHTML(loaded.ydoc) : format === 'text' ? toText(loaded.ydoc) : toProseMirrorJSON(loaded.ydoc);
      loaded.ydoc.destroy();
      reply.header('ETag', `"${loaded.lastUpdateId}"`);
      reply.header('Cache-Control', 'no-store');
      return { format, version: { uptoUpdateId: loaded.lastUpdateId }, content };
    },
  );

  r.patch(
    '/docs/:id',
    { preHandler: [requireRole(deps, 'editor')], schema: { params: IdParams, body: PatchDocBody } },
    async (request) => {
      const ifMatch = request.headers['if-match'];
      if (typeof ifMatch !== 'string' || !ifMatch.trim()) {
        throw new AppError('PRECONDITION_REQUIRED', 428, 'If-Match header with the current version is required');
      }
      const version = Number(ifMatch.replace(/"/g, '').trim());
      if (!Number.isFinite(version)) throw new AppError('VALIDATION_FAILED', 400, 'Invalid If-Match value');
      const [updated] = await db
        .update(documents)
        .set({ title: request.body.title, version: version + 1, updatedAt: new Date() })
        .where(and(eq(documents.id, request.params.id), eq(documents.version, version), isNull(documents.deletedAt)))
        .returning();
      if (!updated) {
        const [current] = await db.select().from(documents).where(eq(documents.id, request.params.id)).limit(1);
        if (!current || current.deletedAt) throw new AppError('DOC_NOT_FOUND', 404, 'Document not found');
        throw new AppError('VERSION_CONFLICT', 412, 'Document was modified by someone else', { current: toDoc(current) });
      }
      await publishDocEvent(pubsub, updated.id, { type: 'doc.updated', payload: { doc: toDoc(updated) } });
      return { doc: toDoc(updated) };
    },
  );

  r.delete('/docs/:id', { preHandler: [requireRole(deps, 'owner')], schema: { params: IdParams } }, async (request, reply) => {
    const docId = request.params.id;
    await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, docId));
    const perms = await db
      .select({ userId: documentPermissions.userId })
      .from(documentPermissions)
      .where(eq(documentPermissions.documentId, docId));
    await Promise.all(perms.map((p) => kv.del(`role:${docId}:${p.userId}`)));
    await publishDocEvent(pubsub, docId, { type: 'doc.deleted', payload: {} });
    await audit(db, { actorId: request.user!.id, action: 'doc.delete', targetType: 'document', targetId: docId, ip: request.ip });
    reply.status(204);
    return null;
  });

  r.post(
    '/docs/:id/socket-ticket',
    { preHandler: [requireRole(deps, 'viewer')], schema: { params: IdParams } },
    async (request) => {
      const [u] = await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1);
      if (!u) throw new AppError('UNAUTHENTICATED', 401, 'Account no longer exists');
      const ticket = randomToken(32);
      const payload: TicketPayload = {
        userId: u.id,
        docId: request.params.id,
        role: request.docRole!,
        name: u.displayName,
        color: u.color,
        iat: Date.now(),
      };
      await kv.set(`ticket:${ticket}`, JSON.stringify(payload), { pxMs: TICKET_TTL_SECONDS * 1000 });
      return {
        ticket,
        wsUrl: deps.config.syncUrl,
        role: request.docRole!,
        expiresAt: iso(new Date(Date.now() + TICKET_TTL_SECONDS * 1000)),
      };
    },
  );

  // keep `sql` referenced for readyz users; avoids unused import when tree-shaken
  void sql;
}
