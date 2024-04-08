import { mkdirSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

export interface QueryResult<T> {
  rows: T[];
  rowCount: number;
}

type Executor = (text: string, params?: unknown[]) => Promise<QueryResult<any>>;

/** Query handle bound to a single transaction. */
export class Tx {
  constructor(
    private readonly exec: Executor,
    private readonly script: (sql: string) => Promise<void>,
  ) {}

  /** Executes a multi-statement SQL script without parameters. */
  run(sql: string): Promise<void> {
    return this.script(sql);
  }

  query<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.exec(text, params);
  }

  async one<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const res = await this.exec(text, params);
    return res.rows[0] as T | undefined;
  }

  async many<T = Record<string, any>>(text: string, params: unknown[] = []): Promise<T[]> {
    const res = await this.exec(text, params);
    return res.rows as T[];
  }
}

export interface Database {
  readonly kind: 'pg' | 'pglite';
  /**
   * Runs `fn` in a transaction as the restricted `fingraph_app` role with the tenant
   * set, so row level security filters every customer-owned table.
   */
  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Runs `fn` in a transaction that bypasses tenant RLS. Platform code paths only. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Raw execution outside the RLS helpers, used by migrations. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function scopeTenant(tx: Tx, tenantId: string) {
  if (!UUID_RE.test(tenantId)) throw new Error('invalid tenant id');
  await tx.query(`select set_config('app.tenant_id', $1, true)`, [tenantId]);
  await tx.query('set local role fingraph_app');
}

async function scopeSystem(tx: Tx) {
  await tx.query(`select set_config('app.bypass_rls', 'on', true)`);
}

// ---------------------------------------------------------------------------
// node-postgres

pg.types.setTypeParser(pg.types.builtins.INT8, (v) => Number(v));
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => Number(v));

class PgDatabase implements Database {
  readonly kind = 'pg' as const;
  private pool: pg.Pool;

  constructor(url: string, max: number) {
    this.pool = new pg.Pool({ connectionString: url, max });
  }

  private async run<T>(scope: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const tx = new Tx(async (text, params) => {
      const r = await client.query(text, params as unknown[]);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    }, async (sql) => {
      await client.query(sql);
    });
    try {
      await client.query('begin');
      await scope(tx);
      const result = await fn(tx);
      await client.query('commit');
      return result;
    } catch (err) {
      await client.query('rollback').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
    return this.run((tx) => scopeTenant(tx, tenantId), fn);
  }

  system<T>(fn: (tx: Tx) => Promise<T>) {
    return this.run(scopeSystem, fn);
  }

  async exec(sql: string) {
    await this.pool.query(sql);
  }

  async close() {
    await this.pool.end();
  }
}

// ---------------------------------------------------------------------------
// PGlite (embedded WASM Postgres) for tests and dependency-free local runs

class PgliteDatabase implements Database {
  readonly kind = 'pglite' as const;

  constructor(private readonly db: import('@electric-sql/pglite').PGlite) {}

  private run<T>(scope: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.db.transaction(async (raw) => {
      const tx = new Tx(async (text, params) => {
        const r = await raw.query(text, params as unknown[]);
        return { rows: r.rows as any[], rowCount: r.affectedRows ?? r.rows.length };
      }, async (sql) => {
        await raw.exec(sql);
      });
      await scope(tx);
      return fn(tx);
    });
  }

  tenant<T>(tenantId: string, fn: (tx: Tx) => Promise<T>) {
    return this.run((tx) => scopeTenant(tx, tenantId), fn);
  }

  system<T>(fn: (tx: Tx) => Promise<T>) {
    return this.run(scopeSystem, fn);
  }

  async exec(sql: string) {
    await this.db.exec(sql);
  }

  async close() {
    await this.db.close();
  }
}

export async function createDatabase(url: string, poolSize = 10): Promise<Database> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return new PgDatabase(url, poolSize);
  }
  if (url.startsWith('pglite://')) {
    const { PGlite, types } = await import('@electric-sql/pglite');
    const { vector } = await import('@electric-sql/pglite-pgvector');
    const target = url.slice('pglite://'.length);
    let dataDir: string | undefined;
    if (target && target !== 'memory') {
      dataDir = path.resolve(target);
      mkdirSync(dataDir, { recursive: true });
    }
    const db = await PGlite.create(dataDir, {
      extensions: { vector },
      parsers: {
        [types.INT8]: (v: string) => Number(v),
        [types.NUMERIC]: (v: string) => Number(v),
      },
    });
    return new PgliteDatabase(db);
  }
  throw new Error(`Unsupported DATABASE_URL: ${url}`);
}
