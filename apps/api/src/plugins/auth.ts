import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { AppError, type Role } from '@confluo/shared';
import type { ApiDeps } from '../types.js';
import type { AuthService } from '../services/auth.js';
import { requireRoleOn } from '../services/roles.js';

export function registerAuthHooks(app: FastifyInstance, auth: AuthService) {
  app.decorateRequest('user', null);
  app.decorateRequest('docRole', null);
  app.addHook('onRequest', async (request) => {
    const h = request.headers.authorization;
    if (h && h.startsWith('Bearer ')) {
      request.user = await auth.verifyAccessToken(h.slice(7).trim());
    }
  });
}

export async function requireAuth(request: FastifyRequest) {
  if (!request.user) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
}

/** preHandler factory: caller must hold at least `min` on `request.params.id`. */
export function requireRole(deps: ApiDeps, min: Role) {
  return async (request: FastifyRequest, _reply: FastifyReply) => {
    if (!request.user) throw new AppError('UNAUTHENTICATED', 401, 'Authentication required');
    const params = request.params as { id?: string };
    if (!params.id) throw new AppError('VALIDATION_FAILED', 400, 'Missing document id');
    request.docRole = await requireRoleOn(deps.adapters, params.id, request.user.id, min);
  };
}

export function requireService(deps: ApiDeps) {
  return async (request: FastifyRequest) => {
    const tok = request.headers['x-service-token'];
    if (typeof tok !== 'string' || tok !== deps.config.serviceToken) {
      throw new AppError('UNAUTHENTICATED', 401, 'Service token required');
    }
  };
}
