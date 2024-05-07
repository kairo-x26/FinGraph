import pino from 'pino';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../src/db';
import { PermanentJobError } from '../src/modules/jobs/errors';
import { claimJob, enqueue, retryJob } from '../src/modules/jobs/queue';
import { Worker } from '../src/modules/jobs/worker';
import { createTestDb } from './helpers';

let db: Database;
let t1: string;
let t2: string;
const log = pino({ level: 'silent' });

beforeAll(async () => {
  db = await createTestDb();
  [t1, t2] = await db.system(async (tx) => [
    (await tx.one<{ id: string }>(`insert into tenants (slug, name) values ('jobs-a', 'A') returning id`))!.id,
    (await tx.one<{ id: string }>(`insert into tenants (slug, name) values ('jobs-b', 'B') returning id`))!.id,
  ]);
});
afterAll(() => db.close());
beforeEach(async () => {
  await db.system((tx) => tx.query('delete from jobs'));
});

const job = (id: string) => db.system((tx) => tx.one('select * from jobs where id = $1', [id]));

describe('job queue', () => {
  it('runs a job and stores its result', async () => {
    const j = await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'echo', payload: { x: 1 } }));
    const w = new Worker({ db, log }).register('echo', async ({ job }) => ({ got: job.payload.x }));
    expect(await w.drain()).toBe(1);
    expect(await job(j.id)).toMatchObject({ status: 'succeeded', attempts: 1, result: { got: 1 } });
  });

  it('retries transient failures with backoff and dead-letters after max attempts', async () => {
    const j = await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'flaky', maxAttempts: 3 }));
    const w = new Worker({ db, log }).register('flaky', async () => {
      throw new Error('upstream timeout');
    });
    await w.drain();
    let row = await job(j.id);
    expect(row).toMatchObject({ status: 'queued', attempts: 1 });
    expect(new Date(row!.run_at).getTime()).toBeGreaterThan(Date.now());
    for (let i = 0; i < 2; i++) {
      await db.system((tx) => tx.query('update jobs set run_at = now() where id = $1', [j.id]));
      await w.drain();
    }
    row = await job(j.id);
    expect(row).toMatchObject({ status: 'dead', attempts: 3, last_error: { type: 'Error', message: 'upstream timeout' } });

    const requeued = await db.tenant(t1, (tx) => retryJob(tx, j.id));
    expect(requeued).toMatchObject({ status: 'queued', attempts: 0 });
  });

  it('fails permanently without retrying', async () => {
    const j = await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'bad' }));
    const w = new Worker({ db, log }).register('bad', async () => {
      throw new PermanentJobError('unsupported_file', 'not a PDF');
    });
    await w.drain();
    expect(await job(j.id)).toMatchObject({ status: 'failed', attempts: 1, last_error: { type: 'unsupported_file' } });
  });

  it('reclaims jobs whose worker lease expired (at-least-once)', async () => {
    const j = await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'echo' }));
    const first = await claimJob(db, { workerId: 'crashed', leaseSeconds: 60 });
    expect(first?.id).toBe(j.id);
    expect(await claimJob(db, { workerId: 'other' })).toBeNull();
    await db.system((tx) => tx.query(`update jobs set lease_until = now() - interval '1 second' where id = $1`, [j.id]));
    const second = await claimJob(db, { workerId: 'other' });
    expect(second).toMatchObject({ id: j.id, attempts: 2, locked_by: 'other' });
  });

  it('limits concurrently running jobs per tenant so one tenant cannot starve others', async () => {
    for (let i = 0; i < 3; i++) await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'echo', priority: 10 }));
    await db.tenant(t2, (tx) => enqueue(tx, { tenantId: t2, kind: 'echo' }));
    const a = await claimJob(db, { workerId: 'w', perTenantLimit: 1 });
    const b = await claimJob(db, { workerId: 'w', perTenantLimit: 1 });
    const c = await claimJob(db, { workerId: 'w', perTenantLimit: 1 });
    expect(a?.tenant_id).toBe(t1);
    expect(b?.tenant_id).toBe(t2);
    expect(c).toBeNull();
  });

  it('deduplicates queued jobs by key', async () => {
    const a = await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'sync', dedupeKey: 'conn-1' }));
    const b = await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'sync', dedupeKey: 'conn-1' }));
    expect(b.id).toBe(a.id);
  });

  it('keeps tenants out of each other’s jobs', async () => {
    await db.tenant(t1, (tx) => enqueue(tx, { tenantId: t1, kind: 'echo' }));
    const seen = await db.tenant(t2, (tx) => tx.many('select id from jobs'));
    expect(seen).toHaveLength(0);
  });
});
