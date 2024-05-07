import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { AppContext } from '../../context';
import { classifyError } from './errors';
import { claimJob, completeJob, extendLease, failJob, type JobRow } from './queue';

export interface JobContext {
  job: JobRow;
  workerId: string;
  /** Extends the job lease; long-running handlers should call this between stages. */
  heartbeat: () => Promise<void>;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

export interface WorkerOptions {
  concurrency?: number;
  pollMs?: number;
  perTenantLimit?: number;
  leaseSeconds?: number;
  kinds?: string[];
}

/**
 * Polls the job table and runs registered handlers with bounded concurrency.
 * Several worker processes can run side by side; `SKIP LOCKED` keeps them apart.
 */
export class Worker {
  readonly id = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  private handlers = new Map<string, JobHandler>();
  private running = new Set<Promise<void>>();
  private stopped = true;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: Pick<AppContext, 'db' | 'log'>,
    private readonly opts: WorkerOptions = {},
  ) {}

  register(kind: string, handler: JobHandler) {
    this.handlers.set(kind, handler);
    return this;
  }

  get kinds() {
    return this.opts.kinds ?? [...this.handlers.keys()];
  }

  /** Claims and runs one job if available. Returns false when the queue is empty. */
  async runOnce(): Promise<boolean> {
    const job = await claimJob(this.ctx.db, {
      workerId: this.id,
      kinds: this.kinds,
      perTenantLimit: this.opts.perTenantLimit,
      leaseSeconds: this.opts.leaseSeconds,
    });
    if (!job) return false;
    await this.execute(job);
    return true;
  }

  /** Processes jobs until the queue is drained (used by tests and CLI tools). */
  async drain(maxJobs = 1000): Promise<number> {
    let n = 0;
    while (n < maxJobs && (await this.runOnce())) n++;
    return n;
  }

  private async execute(job: JobRow) {
    const handler = this.handlers.get(job.kind);
    const log = this.ctx.log.child({ job_id: job.id, kind: job.kind, attempt: job.attempts, tenant_id: job.tenant_id });
    if (!handler) {
      await failJob(this.ctx.db, job, this.id, { type: 'unknown_kind', message: `no handler for ${job.kind}`, retryable: false });
      return;
    }
    const started = Date.now();
    try {
      const result = await handler({
        job,
        workerId: this.id,
        heartbeat: () => extendLease(this.ctx.db, job, this.id, this.opts.leaseSeconds ?? 300),
      });
      await completeJob(this.ctx.db, job, this.id, result ?? null);
      log.info({ ms: Date.now() - started }, 'job succeeded');
    } catch (err) {
      const failure = classifyError(err);
      const status = await failJob(this.ctx.db, job, this.id, failure);
      log.warn({ ms: Date.now() - started, error_type: failure.type, err: failure.message, status }, 'job failed');
    }
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    const concurrency = this.opts.concurrency ?? 2;
    const tick = async () => {
      if (this.stopped) return;
      try {
        while (!this.stopped && this.running.size < concurrency) {
          const job = await claimJob(this.ctx.db, {
            workerId: this.id,
            kinds: this.kinds,
            perTenantLimit: this.opts.perTenantLimit,
            leaseSeconds: this.opts.leaseSeconds,
          });
          if (!job) break;
          const p = this.execute(job).finally(() => this.running.delete(p));
          this.running.add(p);
        }
      } catch (err) {
        this.ctx.log.error({ err }, 'worker poll failed');
      }
      if (!this.stopped) this.timer = setTimeout(tick, this.opts.pollMs ?? 500);
    };
    void tick();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await Promise.allSettled([...this.running]);
  }
}
