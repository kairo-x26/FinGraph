/** Runs the AI evaluation on an in-memory database and writes docs/EVALUATION.md. */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db';
import { migrate } from '../src/db/migrate';
import { reportMarkdown, runEvaluation } from '../src/eval/run';

const config = loadConfig({ ...process.env, NODE_ENV: 'test', DATABASE_URL: 'pglite://memory', WORKER_INLINE: 'false', LOG_LEVEL: 'silent' });
const db = await createDatabase(config.DATABASE_URL);
await migrate(db);
const app = await buildApp({ config, db });
await app.ready();
const report = await runEvaluation(app, db);
const out = path.resolve(process.argv[2] ?? '../../docs/EVALUATION.md');
writeFileSync(out, reportMarkdown(report));
for (const m of report.metrics) console.log(`${m.pass ? 'PASS' : 'MISS'}  ${m.name}: ${m.value} (target ${m.target}) ${m.detail}`);
console.log(`report written to ${out}`);
await app.close();
await db.close();
process.exit(report.metrics.every((m) => m.pass) ? 0 : 1);
