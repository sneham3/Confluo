import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { imageSize } from 'image-size';
import { z } from 'zod';
import { AppError, PresignBody } from '@confluo/shared';
import { assets } from '@confluo/shared/db';
import type { ApiDeps } from '../types.js';
import { requireAuth, requireRole } from '../plugins/auth.js';
import { requireRoleOn } from '../services/roles.js';
import { audit } from '../services/audit.js';
import { extForMime, magicMatches } from '../services/magic.js';
import { iso } from '../lib/dto.js';

const IdParams = z.object({ id: z.uuid() });
const IdAssetParams = z.object({ id: z.uuid(), assetId: z.uuid() });
const AssetQuery = z.object({ json: z.string().optional() });

export function registerAssetRoutes(app: FastifyInstance, deps: ApiDeps) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db, storage } = deps.adapters;

  r.post(
    '/docs/:id/assets/presign',
    {
      preHandler: [requireRole(deps, 'editor')],
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { params: IdParams, body: PresignBody },
    },
    async (request) => {
      const docId = request.params.id;
      const [row] = await db
        .insert(assets)
        .values({
          documentId: docId,
          uploaderId: request.user!.id,
          storageKey: `pending/${docId}/${Date.now()}-${Math.random().toString(36).slice(2)}`,
          mime: request.body.mime,
          byteSize: request.body.byteSize,
          status: 'pending',
        })
        .returning();
      const key = `docs/${docId}/${row!.id}.${extForMime(request.body.mime)}`;
      await db.update(assets).set({ storageKey: key }).where(eq(assets.id, row!.id));
      const expiresSeconds = 300;
      const presigned = await storage.presignPut(key, {
        contentType: request.body.mime,
        contentLength: request.body.byteSize,
        expiresSeconds,
      });
      return {
        assetId: row!.id,
        uploadUrl: presigned.url,
        method: 'PUT' as const,
        headers: presigned.headers,
        expiresAt: iso(new Date(Date.now() + expiresSeconds * 1000)),
      };
    },
  );

  r.post(
    '/docs/:id/assets/:assetId/complete',
    { preHandler: [requireRole(deps, 'editor')], schema: { params: IdAssetParams } },
    async (request) => {
      const [asset] = await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, request.params.assetId), eq(assets.documentId, request.params.id)))
        .limit(1);
      if (!asset) throw new AppError('NOT_FOUND', 404, 'Asset not found');
      if (asset.status === 'ready') {
        return { asset: { id: asset.id, url: `${deps.config.apiUrl}/v1/assets/${asset.id}`, width: asset.width, height: asset.height } };
      }
      const reject = async (code: 'UNSUPPORTED_MEDIA' | 'VALIDATION_FAILED', status: number, msg: string) => {
        await storage.delete(asset.storageKey).catch(() => undefined);
        await db.delete(assets).where(eq(assets.id, asset.id));
        return new AppError(code, status, msg);
      };
      const head = await storage.head(asset.storageKey);
      if (!head) throw new AppError('VALIDATION_FAILED', 400, 'Upload not found; upload the file first');
      if (head.size !== asset.byteSize) throw await reject('VALIDATION_FAILED', 400, 'Uploaded size does not match');
      if (head.contentType && head.contentType !== asset.mime) throw await reject('UNSUPPORTED_MEDIA', 415, 'Content type mismatch');
      const headBytes = await storage.getRange(asset.storageKey, 0, 31);
      if (!magicMatches(headBytes, asset.mime)) throw await reject('UNSUPPORTED_MEDIA', 415, 'File content does not match its type');
      let width: number | null = null;
      let height: number | null = null;
      try {
        const full = await storage.getObject(asset.storageKey);
        const dims = imageSize(full);
        width = dims.width ?? null;
        height = dims.height ?? null;
      } catch {
        /* dimensions optional */
      }
      const [updated] = await db
        .update(assets)
        .set({ status: 'ready', width, height })
        .where(eq(assets.id, asset.id))
        .returning();
      return { asset: { id: updated!.id, url: `${deps.config.apiUrl}/v1/assets/${updated!.id}`, width, height } };
    },
  );

  r.get('/assets/:id', { preHandler: [requireAuth], schema: { params: IdParams, querystring: AssetQuery } }, async (request, reply) => {
    const [asset] = await db.select().from(assets).where(eq(assets.id, request.params.id)).limit(1);
    if (!asset || asset.status !== 'ready') throw new AppError('NOT_FOUND', 404, 'Asset not found');
    await requireRoleOn(deps.adapters, asset.documentId, request.user!.id, 'viewer');
    const url = await storage.presignGet(asset.storageKey, { expiresSeconds: 600, contentType: asset.mime });
    const accept = request.headers.accept ?? '';
    if (request.query.json === '1' || accept.includes('application/json')) return { url };
    reply.redirect(url, 302);
    return reply;
  });

  r.delete('/assets/:id', { preHandler: [requireAuth], schema: { params: IdParams } }, async (request, reply) => {
    const [asset] = await db.select().from(assets).where(eq(assets.id, request.params.id)).limit(1);
    if (!asset) throw new AppError('NOT_FOUND', 404, 'Asset not found');
    const role = await requireRoleOn(deps.adapters, asset.documentId, request.user!.id, 'viewer');
    if (asset.uploaderId !== request.user!.id && role !== 'owner') throw new AppError('FORBIDDEN', 403, 'Not allowed');
    await storage.delete(asset.storageKey).catch(() => undefined);
    await db.delete(assets).where(eq(assets.id, asset.id));
    await audit(db, { actorId: request.user!.id, action: 'asset.delete', targetType: 'asset', targetId: asset.id, ip: request.ip });
    reply.status(204);
    return null;
  });
}
