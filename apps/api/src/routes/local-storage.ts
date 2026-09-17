import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '@confluo/shared';
import type { LocalObjectStorage } from '@confluo/adapters';
import type { ApiDeps } from '../types.js';

const TokenParams = z.object({ token: z.string().min(10).max(4096) });

/** Only mounted in local mode: emulates presigned PUT/GET against disk storage. */
export function registerLocalStorageRoutes(app: FastifyInstance, deps: ApiDeps) {
  const storage = deps.adapters.storage as LocalObjectStorage;
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.put(
    '/local-storage/:token',
    { schema: { params: TokenParams }, config: { rateLimit: false } },
    async (request, reply) => {
      const t = storage.verifyToken(request.params.token);
      if (!t || t.op !== 'put') throw new AppError('FORBIDDEN', 403, 'Invalid or expired upload token');
      const contentType = (request.headers['content-type'] ?? '').split(';')[0]!.trim();
      if (t.contentType && contentType !== t.contentType) throw new AppError('UNSUPPORTED_MEDIA', 415, 'Content type mismatch');
      const body = request.body;
      if (!Buffer.isBuffer(body)) throw new AppError('VALIDATION_FAILED', 400, 'Binary body required');
      if (t.contentLength !== undefined && body.byteLength > t.contentLength) {
        throw new AppError('PAYLOAD_TOO_LARGE', 413, 'Upload exceeds declared size');
      }
      await storage.put(t.key, new Uint8Array(body.buffer, body.byteOffset, body.byteLength), contentType);
      reply.status(204);
      return null;
    },
  );

  r.get('/local-storage/:token', { schema: { params: TokenParams }, config: { rateLimit: false } }, async (request, reply) => {
    const t = storage.verifyToken(request.params.token);
    if (!t || t.op !== 'get') throw new AppError('FORBIDDEN', 403, 'Invalid or expired link');
    const head = await storage.head(t.key);
    if (!head) throw new AppError('NOT_FOUND', 404, 'Object not found');
    const bytes = await storage.getObject(t.key);
    reply
      .type(t.contentType ?? head.contentType ?? 'application/octet-stream')
      .header('Content-Disposition', 'inline')
      .header('Cache-Control', 'private, max-age=600')
      .header('X-Content-Type-Options', 'nosniff');
    return reply.send(Buffer.from(bytes));
  });
}
