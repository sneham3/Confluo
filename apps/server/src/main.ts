import { pino } from 'pino';
import { createAdapters } from '@confluo/adapters';
import { buildApi, seedDemo, sweepOrphanAssets, type ApiDeps } from '@confluo/api';
import { createSyncServer } from '@confluo/sync';
import { ensureJwtKeys, loadEnv, readEnv } from './env.js';

/**
 * All-in-one Confluo server: HTTP API + WebSocket sync on ONE port.
 * Local mode needs nothing but Node. Cloud mode uses Postgres/Redis/S3 from env.
 */
async function main() {
  loadEnv();
  const env = readEnv();
  const isProd = env.NODE_ENV === 'production';
  const logger = pino(
    isProd
      ? { level: env.LOG_LEVEL }
      : {
          level: env.LOG_LEVEL,
          transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } },
        },
  );

  logger.info({ mode: env.CONFLUO_MODE, dataDir: env.DATA_DIR }, 'starting confluo');
  const adapters = await createAdapters(process.env);
  const keys = await ensureJwtKeys(env);

  const apiDeps: ApiDeps = {
    adapters,
    logger,
    config: {
      webUrl: env.WEB_URL,
      apiUrl: env.API_URL,
      syncUrl: env.SYNC_URL,
      jwtPrivateKeyPem: keys.privatePem,
      jwtPublicKeyPem: keys.publicPem,
      serviceToken: env.SERVICE_TOKEN,
      isProd,
    },
  };
  const app = await buildApi(apiDeps);
  const sync = await createSyncServer({
    adapters,
    logger: logger.child({ svc: 'sync' }),
    config: { nodeId: env.SYNC_NODE_ID, webUrl: env.WEB_URL, pathPrefix: '/sync', maxRssMb: env.SYNC_MAX_RSS_MB },
  });

  // Mount the sync server on the same HTTP server (path prefix /sync).
  app.server.on('upgrade', (req, socket, head) => {
    try {
      if (!sync.handleUpgrade(req, socket, head)) socket.destroy();
    } catch (err) {
      logger.error({ err }, 'upgrade failed');
      socket.destroy();
    }
  });

  try {
    app.get('/metrics', async (_req, reply) => {
      reply.header('content-type', 'text/plain; version=0.0.4');
      return sync.metrics();
    });
  } catch {
    /* buildApi may have already sealed the instance; metrics stay optional */
  }

  if (env.SEED_DEMO !== 'false') {
    const seeded = await seedDemo(apiDeps);
    logger.info(
      { users: seeded.users.map((u) => u.email), docId: seeded.docId },
      'demo data ready (password for demo users: password123!)',
    );
  }

  const sweeper = setInterval(() => {
    sweepOrphanAssets(apiDeps).catch((err) => logger.warn({ err }, 'orphan sweep failed'));
  }, 60 * 60 * 1000);
  sweeper.unref();

  await app.listen({ port: env.PORT, host: env.HOST });
  logger.info(`API    → ${env.API_URL}/v1`);
  logger.info(`Sync   → ${env.SYNC_URL}/v1/docs/:id`);
  logger.info(`Web    → ${env.WEB_URL} (run: pnpm dev:web)`);

  let closing = false;
  const shutdown = async (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, 'shutting down');
    clearInterval(sweeper);
    const timer = setTimeout(() => process.exit(1), 15_000);
    timer.unref();
    try {
      await sync.close();
      await app.close();
      await adapters.close();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
