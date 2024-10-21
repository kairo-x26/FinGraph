/**
 * Serves an in-memory PGlite (with pgvector) over the Postgres wire protocol so the
 * `pg` driver code path can be tested without installing Postgres:
 *   tsx scripts/pg-wire-server.ts 55432
 */
import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

const port = Number(process.argv[2] ?? 55432);
const db = await PGlite.create({ extensions: { vector } });
const server = new PGLiteSocketServer({ db, port, host: '127.0.0.1', maxConnections: 20 } as ConstructorParameters<typeof PGLiteSocketServer>[0]);
await server.start();
console.log(`pglite listening on postgres://postgres@127.0.0.1:${port}/postgres`);
