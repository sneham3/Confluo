import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { schema } from '@confluo/shared/db';
import type { Db } from './types.js';

export interface DbHandle {
  db: Db;
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Local mode: PGlite (embedded Postgres, single process) persisted under `${dataDir}/pglite`.
 * Cloud mode: node-postgres pool.
 */
export async function createDb(
  opts: { mode: 'local'; dataDir: string } | { mode: 'cloud'; databaseUrl: string },
): Promise<DbHandle> {
  const migrationsFolder = await resolveMigrationsFolder();
  if (opts.mode === 'local') {
    const { PGlite } = await import('@electric-sql/pglite');
    const { drizzle } = await import('drizzle-orm/pglite');
    const { migrate } = await import('drizzle-orm/pglite/migrator');
    const dir = path.join(opts.dataDir, 'pglite');
    await mkdir(dir, { recursive: true });
    const client = new PGlite(dir);
    await client.waitReady;
    const db = drizzle({ client, schema });
    return {
      db: db as unknown as Db,
      migrate: () => migrate(db, { migrationsFolder }),
      close: () => client.close(),
    };
  }
  const { default: pg } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { migrate } = await import('drizzle-orm/node-postgres/migrator');
  const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
  const db = drizzle({ client: pool, schema });
  return {
    db: db as unknown as Db,
    migrate: () => migrate(db, { migrationsFolder }),
    close: () => pool.end(),
  };
}

async function resolveMigrationsFolder(): Promise<string> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pkgJson = require.resolve('@confluo/shared/package.json');
  return path.join(path.dirname(pkgJson), 'drizzle');
}
