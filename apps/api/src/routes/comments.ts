import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { AppError, CommentListQuery, CreateCommentBody, PatchCommentBody, isAtLeast } from '@confluo/shared';
import { comments, users } from '@confluo/shared/db';
import type { ApiDeps } from '../types.js';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { publishDocEvent } from '../services/events.js';
import { requireRoleOn } from '../services/roles.js';
import { b64ToBytes, toComment, toUserPublic } from '../lib/dto.js';

const IdParams = z.object({ id: z.uuid() });
const COMMENT_LIMIT = { rateLimit: { max: 60, timeWindow: '1 minute' } };

export function registerCommentRoutes(app: FastifyInstance, deps: ApiDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, pubsub } = deps.adapters;

  const loadComment = async (id: string) => {
    const [row] = await db
      .select({ c: comments, author: users })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.id, id), isNull(comments.deletedAt)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 404, 'Comment not found');
    return row;
  };

  r.get(
    '/docs/:id/comments',
    { preHandler: [requireRole(deps, 'viewer')], schema: { params: IdParams, querystring: CommentListQuery } },
    async (request) => {
      const rows = await db
        .select({ c: comments, author: users })
        .from(comments)
        .innerJoin(users, eq(users.id, comments.authorId))
        .where(
          and(
            eq(comments.documentId, request.params.id),
            isNull(comments.deletedAt),
            request.query.includeResolved ? undefined : isNull(comments.resolvedAt),
          ),
        )
        .orderBy(asc(comments.createdAt));
      return { items: rows.map((row) => toComment(row.c, toUserPublic(row.author))) };
    },
  );

  r.post(
    '/docs/:id/comments',
    { preHandler: [requireRole(deps, 'commenter')], config: COMMENT_LIMIT, schema: { params: IdParams, body: CreateCommentBody } },
    async (request, reply) => {
      const docId = request.params.id;
      const anchorFrom = b64ToBytes(request.body.anchorFrom);
      const anchorTo = b64ToBytes(request.body.anchorTo);
      if ((anchorFrom && anchorFrom.byteLength > 256) || (anchorTo && anchorTo.byteLength > 256)) {
        throw new AppError('VALIDATION_FAILED', 400, 'Comment anchor too large');
      }
      if (request.body.parentId) {
        const [parent] = await db
          .select({ id: comments.id, documentId: comments.documentId, parentId: comments.parentId })
          .from(comments)
          .where(and(eq(comments.id, request.body.parentId), isNull(comments.deletedAt)))
          .limit(1);
        if (!parent || parent.documentId !== docId) throw new AppError('VALIDATION_FAILED', 400, 'Invalid parent comment');
        if (parent.parentId) throw new AppError('VALIDATION_FAILED', 400, 'Replies can only be one level deep');
      }
      const [row] = await db
        .insert(comments)
        .values({
          documentId: docId,
          authorId: request.user!.id,
          parentId: request.body.parentId ?? null,
          anchorFrom,
          anchorTo,
          blockId: request.body.blockId ?? null,
          body: request.body.body,
        })
        .returning();
      const [author] = await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1);
      const dto = toComment(row!, toUserPublic(author!));
      await publishDocEvent(pubsub, docId, { type: 'comment.created', payload: { comment: dto } });
      reply.status(201);
      return { comment: dto };
    },
  );

  r.patch(
    '/comments/:id',
    { preHandler: [requireAuth], config: COMMENT_LIMIT, schema: { params: IdParams, body: PatchCommentBody } },
    async (request) => {
      const { c, author } = await loadComment(request.params.id);
      const userId = request.user!.id;
      const role = await requireRoleOn(deps.adapters, c.documentId, userId, 'viewer');
      const isAuthor = c.authorId === userId;
      const isOwner = role === 'owner';
      const patch: Partial<typeof comments.$inferInsert> = { updatedAt: new Date() };
      if (request.body.body !== undefined) {
        if (!isAuthor && !isOwner) throw new AppError('FORBIDDEN', 403, 'Only the author can edit this comment');
        patch.body = request.body.body;
      }
      if (request.body.resolved !== undefined) {
        const allowed = isOwner || isAtLeast(role, 'editor') || (isAuthor && isAtLeast(role, 'commenter'));
        if (!allowed) throw new AppError('FORBIDDEN', 403, 'Not allowed to resolve this comment');
        patch.resolvedAt = request.body.resolved ? new Date() : null;
        patch.resolvedBy = request.body.resolved ? userId : null;
      }
      const [updated] = await db.update(comments).set(patch).where(eq(comments.id, c.id)).returning();
      const dto = toComment(updated!, toUserPublic(author));
      await publishDocEvent(pubsub, c.documentId, { type: 'comment.updated', payload: { comment: dto } });
      return { comment: dto };
    },
  );

  r.delete('/comments/:id', { preHandler: [requireAuth], schema: { params: IdParams } }, async (request, reply) => {
    const { c, author } = await loadComment(request.params.id);
    const userId = request.user!.id;
    const role = await requireRoleOn(deps.adapters, c.documentId, userId, 'viewer');
    if (c.authorId !== userId && role !== 'owner') throw new AppError('FORBIDDEN', 403, 'Not allowed to delete this comment');
    const now = new Date();
    await db.update(comments).set({ deletedAt: now }).where(eq(comments.id, c.id));
    await db.update(comments).set({ deletedAt: now }).where(and(eq(comments.parentId, c.id), isNull(comments.deletedAt)));
    await publishDocEvent(pubsub, c.documentId, {
      type: 'comment.deleted',
      payload: { comment: toComment({ ...c, deletedAt: now }, toUserPublic(author)) },
    });
    reply.status(204);
    return null;
  });
}
