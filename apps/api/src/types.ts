import type { Adapters } from '@confluo/adapters';
import type { Logger } from 'pino';
import type { Role } from '@confluo/shared';

export interface ApiConfig {
  webUrl: string;
  apiUrl: string;
  syncUrl: string;
  jwtPrivateKeyPem: string;
  jwtPublicKeyPem: string;
  serviceToken: string;
  isProd: boolean;
}

export interface ApiDeps {
  adapters: Adapters;
  config: ApiConfig;
  logger: Logger;
}

export interface AuthUser {
  id: string;
  name: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: AuthUser | null;
    docRole: Role | null;
  }
}
