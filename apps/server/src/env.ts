import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { exportPKCS8, exportSPKI, generateKeyPair } from 'jose';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '../../..');

/** Load `.env` from the repo root first, then the current working directory (later wins nothing: first value kept). */
export function loadEnv(): void {
  loadDotenv({ path: path.join(repoRoot, '.env'), quiet: true });
  loadDotenv({ path: path.join(process.cwd(), '.env'), quiet: true });
}

export const ServerEnvSchema = z.object({
  CONFLUO_MODE: z.enum(['local', 'cloud']).default('local'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  WEB_URL: z.string().default('http://localhost:3000'),
  API_URL: z.string().default('http://localhost:4000'),
  SYNC_URL: z.string().default('ws://localhost:4000/sync'),
  JWT_PRIVATE_KEY: z.string().optional(),
  JWT_PUBLIC_KEY: z.string().optional(),
  SERVICE_TOKEN: z.string().min(8).default('change-me-service-token'),
  SYNC_NODE_ID: z.string().default('node-a'),
  SYNC_MAX_RSS_MB: z.coerce.number().default(1024),
  DATA_DIR: z.string().default('.data'),
  SEED_DEMO: z.string().default('true'),
  NODE_ENV: z.string().default('development'),
  LOG_LEVEL: z.string().default('info'),
});
export type ServerEnv = z.infer<typeof ServerEnvSchema>;

export function readEnv(): ServerEnv {
  const env = ServerEnvSchema.parse(process.env);
  // Resolve DATA_DIR relative to the repo root so `pnpm dev` from any cwd shares one data dir.
  env.DATA_DIR = path.isAbsolute(env.DATA_DIR) ? env.DATA_DIR : path.join(repoRoot, env.DATA_DIR);
  process.env.DATA_DIR = env.DATA_DIR;
  return env;
}

/** Use configured ES256 keys, or create/load a dev key pair under DATA_DIR. */
export async function ensureJwtKeys(env: ServerEnv): Promise<{ privatePem: string; publicPem: string }> {
  const fromEnv = (v?: string) => (v ? v.replace(/\\n/g, '\n') : '');
  if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
    return { privatePem: fromEnv(env.JWT_PRIVATE_KEY), publicPem: fromEnv(env.JWT_PUBLIC_KEY) };
  }
  await mkdir(env.DATA_DIR, { recursive: true });
  const privPath = path.join(env.DATA_DIR, 'jwt-private.pem');
  const pubPath = path.join(env.DATA_DIR, 'jwt-public.pem');
  try {
    const [privatePem, publicPem] = await Promise.all([readFile(privPath, 'utf8'), readFile(pubPath, 'utf8')]);
    return { privatePem, publicPem };
  } catch {
    const { privateKey, publicKey } = await generateKeyPair('ES256', { extractable: true });
    const privatePem = await exportPKCS8(privateKey);
    const publicPem = await exportSPKI(publicKey);
    await Promise.all([writeFile(privPath, privatePem), writeFile(pubPath, publicPem)]);
    return { privatePem, publicPem };
  }
}
