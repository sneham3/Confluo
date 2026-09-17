import path from 'node:path';
import { AdapterEnvSchema, type AdapterEnv } from './config.js';
import { createDb } from './db.js';
import { MemoryKeyValue } from './kv-memory.js';
import { MemoryPubSub } from './pubsub-memory.js';
import { LocalObjectStorage } from './storage-local.js';
import type { Adapters } from './types.js';

export * from './types.js';
export * from './config.js';
export { MemoryKeyValue } from './kv-memory.js';
export { MemoryPubSub } from './pubsub-memory.js';
export { LocalObjectStorage, type LocalStorageToken } from './storage-local.js';
export { createDb, type DbHandle } from './db.js';

/**
 * Build the adapter set from environment. In local mode nothing external is needed.
 * Cloud-mode adapters are loaded lazily so local mode never touches ioredis/aws-sdk.
 */
export async function createAdapters(env: NodeJS.ProcessEnv = process.env): Promise<Adapters> {
  const cfg: AdapterEnv = AdapterEnvSchema.parse(env);
  if (cfg.CONFLUO_MODE === 'local') {
    const dataDir = path.resolve(cfg.DATA_DIR);
    const dbh = await createDb({ mode: 'local', dataDir });
    await dbh.migrate();
    const kv = new MemoryKeyValue();
    const pubsub = new MemoryPubSub();
    const storage = new LocalObjectStorage(path.join(dataDir, 'uploads'), cfg.API_URL, cfg.SERVICE_TOKEN);
    return {
      mode: 'local',
      db: dbh.db,
      kv,
      pubsub,
      storage,
      close: async () => {
        await Promise.all([kv.close(), pubsub.close(), dbh.close()]);
      },
    };
  }

  if (!cfg.DATABASE_URL || !cfg.REDIS_URL || !cfg.S3_BUCKET || !cfg.S3_ACCESS_KEY || !cfg.S3_SECRET_KEY) {
    throw new Error('CONFLUO_MODE=cloud requires DATABASE_URL, REDIS_URL and S3_* variables');
  }
  const [{ RedisKeyValue }, { RedisPubSub }, { S3ObjectStorage }] = await Promise.all([
    import('./kv-redis.js'),
    import('./pubsub-redis.js'),
    import('./storage-s3.js'),
  ]);
  const dbh = await createDb({ mode: 'cloud', databaseUrl: cfg.DATABASE_URL });
  await dbh.migrate();
  const kv = new RedisKeyValue(cfg.REDIS_URL);
  const pubsub = new RedisPubSub(cfg.REDIS_URL);
  const storage = new S3ObjectStorage({
    endpoint: cfg.S3_ENDPOINT,
    region: cfg.S3_REGION,
    bucket: cfg.S3_BUCKET,
    accessKey: cfg.S3_ACCESS_KEY,
    secretKey: cfg.S3_SECRET_KEY,
    forcePathStyle: cfg.S3_FORCE_PATH_STYLE,
  });
  return {
    mode: 'cloud',
    db: dbh.db,
    kv,
    pubsub,
    storage,
    close: async () => {
      await Promise.all([kv.close(), pubsub.close(), dbh.close()]);
    },
  };
}
