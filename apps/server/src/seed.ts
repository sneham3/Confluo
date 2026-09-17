import { pino } from 'pino';
import { createAdapters } from '@confluo/adapters';
import { seedDemo } from '@confluo/api';
import { ensureJwtKeys, loadEnv, readEnv } from './env.js';

async function main() {
  loadEnv();
  const env = readEnv();
  const logger = pino({ level: 'info' });
  const adapters = await createAdapters(process.env);
  const keys = await ensureJwtKeys(env);
  const result = await seedDemo({
    adapters,
    logger,
    config: {
      webUrl: env.WEB_URL,
      apiUrl: env.API_URL,
      syncUrl: env.SYNC_URL,
      jwtPrivateKeyPem: keys.privatePem,
      jwtPublicKeyPem: keys.publicPem,
      serviceToken: env.SERVICE_TOKEN,
      isProd: false,
    },
  });
  console.log('Seeded demo data:');
  for (const u of result.users) console.log(`  ${u.email}  /  ${u.password}`);
  console.log(`  demo document: ${result.docId}`);
  await adapters.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
