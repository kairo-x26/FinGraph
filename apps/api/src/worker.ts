import pino from 'pino';
import { loadConfig } from './config';
import { createDatabase } from './db';
import { migrate } from './db/migrate';
import { createDispatcher, createScheduler, createWorker } from './jobs';
import { createContext } from './services';

const config = loadConfig();
const log = pino({ level: config.LOG_LEVEL, base: { service: 'fingraph-worker' } });
const db = await createDatabase(config.DATABASE_URL, config.DATABASE_POOL_SIZE);
await migrate(db, (m) => log.info(`applied ${m}`));
const ctx = createContext(config, db, log);
const worker = createWorker(ctx);
worker.start();
const scheduler = createScheduler(ctx);
scheduler.start();
const dispatcher = createDispatcher(ctx);
dispatcher.start();
log.info({ worker: worker.id, kinds: worker.kinds }, 'worker started');

const shutdown = async (signal: string) => {
  log.info({ signal }, 'stopping worker');
  scheduler.stop();
  dispatcher.stop();
  await worker.stop();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
