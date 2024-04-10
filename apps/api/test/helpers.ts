import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { testConfig, type Config } from '../src/config';
import { createDatabase, type Database } from '../src/db';
import { migrate } from '../src/db/migrate';

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  config: Config;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<Database> {
  const db = await createDatabase('pglite://memory');
  await migrate(db);
  return db;
}

export async function createTestEnv(overrides: Parameters<typeof testConfig>[0] = {}): Promise<TestEnv> {
  const config = testConfig(overrides);
  const db = await createTestDb();
  const app = await buildApp({ config, db });
  await app.ready();
  return {
    app,
    db,
    config,
    close: async () => {
      await app.close();
      await db.close();
    },
  };
}
