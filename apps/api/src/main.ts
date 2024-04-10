import { buildApp } from './app';
import { loadConfig } from './config';
import { createDatabase } from './db';
import { migrate } from './db/migrate';

async function main() {
  const config = loadConfig();
  const db = await createDatabase(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
  await migrate(db, (m) => console.log(`[migrate] ${m}`));

  const app = await buildApp({ config, db });

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: config.PORT, host: config.HOST });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
