import { createServer } from 'node:http';
import { pino } from 'pino';
import { createAdapters } from '@confluo/adapters';
import { createSyncServer } from './server.js';

/** Standalone sync node (cloud/scaled deployments). The all-in-one dev server mounts the same core. */
async function main() {
  const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });
  const port = Number(process.env.PORT ?? 4100);
  const adapters = await createAdapters(process.env);
  const sync = await createSyncServer({
    adapters,
    logger,
    config: {
      nodeId: process.env.SYNC_NODE_ID ?? `node-${process.pid}`,
      webUrl: process.env.WEB_URL ?? 'http://localhost:3000',
      pathPrefix: '',
      maxRssMb: Number(process.env.SYNC_MAX_RSS_MB ?? 1024),
    },
  });

  const server = createServer(async (req, res) => {
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(await sync.metrics());
      return;
    }
    if (req.url === '/healthz' || req.url === '/readyz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ...sync.stats() }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!sync.handleUpgrade(req, socket, head)) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  server.listen(port, () => logger.info({ port }, 'sync server listening'));

  const shutdown = async () => {
    logger.info('shutting down');
    server.close();
    await sync.close();
    await adapters.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
