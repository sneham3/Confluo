import path from 'node:path';
import { readFileSync } from 'node:fs';
import pino from 'pino';

// Minimal .env loader (no extra dependency): does not override already-set variables.
try {
  for (const line of readFileSync(path.resolve('.env'), 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || line.trim().startsWith('#')) continue;
    const key = m[1]!;
    const val = m[2]!.replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  /* no .env file */
}
import { createAdapters } from '@confluo/adapters';
import { buildApi } from './app.js';
import { ensureJwtKeys } from './lib/keys.js';
import { sweepOrphanAssets } from './sweeper.js';

async function main() {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const adapters = await createAdapters();
  const dataDir = path.resolve(process.env.DATA_DIR ?? '.data');
  const keys = await ensureJwtKeys(dataDir);
  const deps = {
    adapters,
    logger,
    config: {
      webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
      apiUrl: process.env.API_URL ?? 'http://localhost:4000',
      syncUrl: process.env.SYNC_URL ?? 'ws://localhost:4100',
      jwtPrivateKeyPem: keys.privateKeyPem,
      jwtPublicKeyPem: keys.publicKeyPem,
      serviceToken: process.env.SERVICE_TOKEN ?? 'change-me-service-token',
      isProd: process.env.NODE_ENV === 'production',
    },
  };
  const app = await buildApi(deps);
  const port = Number(process.env.PORT ?? 4000);
  await app.listen({ port, host: '0.0.0.0' });
  logger.info({ port, mode: adapters.mode }, 'api listening');

  const sweeper = setInterval(() => {
    sweepOrphanAssets(deps).catch((err) => logger.warn({ err }, 'sweeper failed'));
  }, 3600_000);
  sweeper.unref();

  const shutdown = async () => {
    clearInterval(sweeper);
    await app.close();
    await adapters.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
