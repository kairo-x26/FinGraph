import type { AppContext } from '../../context';
import { enqueue } from './queue';

export interface ScheduledTask {
  task: string;
  kind: string;
  everyMs: number;
  payload?: Record<string, unknown>;
}

/**
 * Periodically enqueues maintenance jobs for every active tenant. Safe to run in
 * several workers: claiming a slot is an atomic conditional upsert.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: Pick<AppContext, 'db' | 'log'>,
    private readonly tasks: ScheduledTask[],
  ) {}

  async tick(now = new Date()): Promise<number> {
    const tenants = await this.ctx.db.system((tx) => tx.many<{ id: string }>(`select id from tenants where status = 'active'`));
    let queued = 0;
    for (const t of tenants) {
      for (const task of this.tasks) {
        const claimed = await this.ctx.db.system((tx) =>
          tx.one(
            `insert into scheduled_runs (tenant_id, task, last_run_at) values ($1, $2, $3)
             on conflict (tenant_id, task) do update set last_run_at = excluded.last_run_at
               where scheduled_runs.last_run_at < $3::timestamptz - make_interval(secs => $4)
             returning task`,
            [t.id, task.task, now, task.everyMs / 1000],
          ),
        );
        if (!claimed) continue;
        await this.ctx.db.tenant(t.id, (tx) =>
          enqueue(tx, { tenantId: t.id, kind: task.kind, payload: task.payload, dedupeKey: `scheduled:${task.task}`, priority: -5 }),
        );
        queued++;
      }
    }
    return queued;
  }

  start(intervalMs = 60_000) {
    if (this.timer) return;
    const run = () =>
      this.tick().catch((err) => this.ctx.log.error({ err }, 'scheduler tick failed'));
    void run();
    this.timer = setInterval(run, intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
