import fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { ApiDeps } from './types.js';
import { AuthService } from './services/auth.js';
import { registerAuthHooks } from './plugins/auth.js';
import { registerErrorHandler } from './lib/errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerDocRoutes } from './routes/docs.js';
import { registerPermissionRoutes } from './routes/permissions.js';
import { registerCommentRoutes } from './routes/comments.js';
import { registerAssetRoutes } from './routes/assets.js';
import { registerLocalStorageRoutes } from './routes/local-storage.js';
import { registerInternalRoutes } from './routes/internal.js';

/** Build the API (plugins + routes under /v1). Does not listen. */
export async function buildApi(deps: ApiDeps): Promise<FastifyInstance> {
  const app = fastify({
    loggerInstance: deps.logger as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 12 * 1024 * 1024,
    maxParamLength: 4096, // local-storage signed tokens are long

  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const auth = new AuthService(deps);
  await auth.init();

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: deps.config.webUrl,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'If-Match', 'Accept'],
    exposedHeaders: ['ETag', 'x-request-id'],
  });
  await app.register(cookie);

  registerAuthHooks(app, auth);

  const disableRateLimit = process.env.CONFLUO_DISABLE_RATE_LIMIT === '1';
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.user?.id ?? request.ip,
    allowList: () => disableRateLimit,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  // Raw binary bodies for local-storage uploads.
  app.addContentTypeParser(
    ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  registerErrorHandler(app);

  await app.register(
    async (v1) => {
      registerAuthRoutes(v1, deps, auth);
      registerDocRoutes(v1, deps);
      registerPermissionRoutes(v1, deps);
      registerCommentRoutes(v1, deps);
      registerAssetRoutes(v1, deps);
      registerInternalRoutes(v1, deps);
      if (deps.adapters.storage.kind === 'local') registerLocalStorageRoutes(v1, deps);
    },
    { prefix: '/v1' },
  );

  return app;
}
