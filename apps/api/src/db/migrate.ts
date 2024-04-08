import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from './index';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Resolved relative to this file in dev, or next to the bundle in dist. */
function migrationsDir(): string {
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations')];
  for (const dir of candidates) {
    try {
      readdirSync(dir);
      return dir;
    } catch {
      /* try next */
    }
  }
  throw new Error('migrations directory not found');
}

export interface Migration {
  name: string;
  sql: string;
}

export function loadMigrations(dir = migrationsDir()): Migration[] {
  return readdirSync(dir)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort()
    .map((name) => ({ name, sql: readFileSync(path.join(dir, name), 'utf8') }));
}

export async function migrate(db: Database, log: (msg: string) => void = () => undefined) {
  await db.exec(`
    create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`);
  const applied = await db.system((tx) =>
    tx.many<{ name: string }>('select name from schema_migrations'),
  );
  const done = new Set(applied.map((r) => r.name));
  const pending = loadMigrations().filter((m) => !done.has(m.name));
  for (const m of pending) {
    await db.system(async (tx) => {
      await tx.run(m.sql);
      await tx.query('insert into schema_migrations (name) values ($1)', [m.name]);
    });
    log(`applied ${m.name}`);
  }
  return pending.map((m) => m.name);
}
