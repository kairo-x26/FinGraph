import type { Database, Tx } from '../../db';

export interface JobRow {
  id: string;
  tenant_id: string;
  kind: string;
  payload: Record<string, unknown>;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'dead';
  priority: number;
  attempts: number;
  max_attempts: number;
  run_at: Date;
  locked_by: string | null;
  lease_until: Date | null;
  dedupe_key: string | null;
  resource_type: string | null;
  resource_id: string | null;
  last_error: { type: string; message: string } | null;
  result: unknown;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface EnqueueInput {
  tenantId: string;
  kind: string;
  payload?: Record<string, unknown>;
  priority?: number;
  runAt?: Date;
  maxAttempts?: number;
  /** While a job with the same key is queued or running, enqueue returns that job instead. */
  dedupeKey?: string;
  resource?: { type: string; id: string };
  createdBy?: string | null;
}

export async function enqueue(tx: Tx, input: EnqueueInput): Promise<JobRow> {
  if (input.dedupeKey) {
    const existing = await tx.one<JobRow>(
      `select * from jobs where tenant_id = $1 and dedupe_key = $2 and status in ('queued', 'running')`,
      [input.tenantId, input.dedupeKey],
    );
    if (existing) return existing;
  }
  const row = await tx.one<JobRow>(
    `insert into jobs (tenant_id, kind, payload, priority, run_at, max_attempts, dedupe_key, resource_type, resource_id, created_by)
     values ($1, $2, $3, $4, coalesce($5, now()), $6, $7, $8, $9, $10) returning *`,
    [
      input.tenantId,
      input.kind,
      JSON.stringify(input.payload ?? {}),
      input.priority ?? 0,
      input.runAt ?? null,
      input.maxAttempts ?? 5,
      input.dedupeKey ?? null,
      input.resource?.type ?? null,
      input.resource?.id ?? null,
      input.createdBy ?? null,
    ],
  );
  return row!;
}

export interface ClaimOptions {
  workerId: string;
  kinds?: string[];
  leaseSeconds?: number;
  /** Maximum concurrently running jobs per tenant (backpressure / fairness). */
  perTenantLimit?: number;
}

/**
 * Claims the next runnable job. Jobs whose lease expired (crashed worker) are
 * reclaimed, which gives at-least-once delivery; handlers must be idempotent.
 */
export async function claimJob(db: Database, opts: ClaimOptions): Promise<JobRow | null> {
  const lease = opts.leaseSeconds ?? 300;
  const limit = opts.perTenantLimit ?? 4;
  return db.system(async (tx) => {
    const row = await tx.one<JobRow>(
      `with candidate as (
         select j.id from jobs j
          where ((j.status = 'queued' and j.run_at <= now())
             or (j.status = 'running' and j.lease_until < now()))
            and ($1::text[] is null or j.kind = any($1))
            and (select count(*) from jobs r
                  where r.tenant_id = j.tenant_id and r.status = 'running' and r.lease_until >= now()) < $2
          order by j.priority desc, j.run_at
          limit 1
          for update skip locked)
       update jobs set status = 'running', attempts = jobs.attempts + 1, locked_by = $3,
                       lease_until = now() + make_interval(secs => $4), started_at = coalesce(jobs.started_at, now())
         from candidate where jobs.id = candidate.id
       returning jobs.*`,
      [opts.kinds ?? null, limit, opts.workerId, lease],
    );
    return row ?? null;
  });
}

export async function extendLease(db: Database, job: JobRow, workerId: string, seconds = 300) {
  await db.system((tx) =>
    tx.query(
      `update jobs set lease_until = now() + make_interval(secs => $3) where id = $1 and locked_by = $2 and status = 'running'`,
      [job.id, workerId, seconds],
    ),
  );
}

export async function completeJob(db: Database, job: JobRow, workerId: string, result: unknown = null) {
  await db.system((tx) =>
    tx.query(
      `update jobs set status = 'succeeded', result = $3, finished_at = now(), lease_until = null, last_error = null
        where id = $1 and locked_by = $2`,
      [job.id, workerId, JSON.stringify(result)],
    ),
  );
}

/** Exponential backoff with jitter: 2s, 4s, 8s ... capped at 10 minutes. */
export function backoffSeconds(attempt: number, base = 2, cap = 600): number {
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp * (0.75 + Math.random() * 0.5));
}

export interface FailureInfo {
  type: string;
  message: string;
  retryable: boolean;
}

/** Records a failure; retryable errors are rescheduled until max_attempts, then dead-lettered. */
export async function failJob(db: Database, job: JobRow, workerId: string, failure: FailureInfo) {
  const exhausted = job.attempts >= job.max_attempts;
  const status = !failure.retryable ? 'failed' : exhausted ? 'dead' : 'queued';
  const delay = backoffSeconds(job.attempts);
  await db.system((tx) =>
    tx.query(
      `update jobs set status = $3, last_error = $4, lease_until = null, locked_by = null,
                       run_at = case when $3 = 'queued' then now() + make_interval(secs => $5) else run_at end,
                       finished_at = case when $3 = 'queued' then null else now() end
        where id = $1 and locked_by = $2`,
      [job.id, workerId, status, JSON.stringify({ type: failure.type, message: failure.message.slice(0, 2000) }), delay],
    ),
  );
  return status as 'queued' | 'failed' | 'dead';
}

/** Requeues a failed or dead job (operator action). */
export async function retryJob(tx: Tx, jobId: string) {
  return tx.one<JobRow>(
    `update jobs set status = 'queued', run_at = now(), attempts = 0, finished_at = null, last_error = null
      where id = $1 and status in ('failed', 'dead') returning *`,
    [jobId],
  );
}
