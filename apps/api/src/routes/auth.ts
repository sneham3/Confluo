import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { AppError, LoginBody, RegisterBody } from '@confluo/shared';
import { users } from '@confluo/shared/db';
import type { ApiDeps } from '../types.js';
import { REFRESH_COOKIE, REFRESH_TTL_MS, type AuthService } from '../services/auth.js';
import { audit } from '../services/audit.js';
import { toUser } from '../lib/dto.js';
import { requireAuth } from '../plugins/auth.js';

const AUTH_LIMIT = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export function registerAuthRoutes(app: FastifyInstance, deps: ApiDeps, auth: AuthService) {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const { db } = deps.adapters;

  const setRefreshCookie = (reply: FastifyReply, raw: string) => {
    reply.setCookie(REFRESH_COOKIE, raw, {
      httpOnly: true,
      sameSite: 'lax',
      secure: deps.config.isProd,
      path: '/v1/auth',
      maxAge: Math.floor(REFRESH_TTL_MS / 1000),
    });
  };

  const checkOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (origin && origin !== deps.config.webUrl) {
      throw new AppError('FORBIDDEN', 403, 'Cross-origin session operation rejected');
    }
  };

  r.post('/auth/register', { ...AUTH_LIMIT, schema: { body: RegisterBody } }, async (request, reply) => {
    const row = await auth.register(request.body);
    const accessToken = await auth.signAccessToken({ id: row.id, name: row.displayName });
    const raw = await auth.issueRefresh(row.id, request.headers['user-agent']);
    setRefreshCookie(reply, raw);
    await audit(db, { actorId: row.id, action: 'auth.register', targetType: 'user', targetId: row.id, ip: request.ip });
    reply.status(201);
    return { user: toUser(row), accessToken };
  });

  r.post('/auth/login', { ...AUTH_LIMIT, schema: { body: LoginBody } }, async (request, reply) => {
    const row = await auth.login(request.body);
    const accessToken = await auth.signAccessToken({ id: row.id, name: row.displayName });
    const raw = await auth.issueRefresh(row.id, request.headers['user-agent']);
    setRefreshCookie(reply, raw);
    await audit(db, { actorId: row.id, action: 'auth.login', targetType: 'user', targetId: row.id, ip: request.ip });
    return { user: toUser(row), accessToken };
  });

  r.post('/auth/refresh', AUTH_LIMIT, async (request, reply) => {
    checkOrigin(request);
    const raw = request.cookies[REFRESH_COOKIE];
    if (!raw) throw new AppError('UNAUTHENTICATED', 401, 'No session');
    try {
      const { user, raw: next } = await auth.rotateRefresh(raw, request.headers['user-agent']);
      setRefreshCookie(reply, next);
      const accessToken = await auth.signAccessToken({ id: user.id, name: user.displayName });
      return { accessToken };
    } catch (e) {
      reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
      throw e;
    }
  });

  r.post('/auth/logout', async (request, reply) => {
    checkOrigin(request);
    const raw = request.cookies[REFRESH_COOKIE];
    if (raw) await auth.revokeFamilyByRaw(raw);
    reply.clearCookie(REFRESH_COOKIE, { path: '/v1/auth' });
    reply.status(204);
    return null;
  });

  r.get('/me', { preHandler: [requireAuth] }, async (request) => {
    const [row] = await db.select().from(users).where(eq(users.id, request.user!.id)).limit(1);
    if (!row) throw new AppError('UNAUTHENTICATED', 401, 'Account no longer exists');
    return { user: toUser(row) };
  });
}
