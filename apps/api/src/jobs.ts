import type { AppContext } from './context';
import { ingestionHandler, INGEST_JOB } from './modules/ingestion/pipeline';
import { Worker, type WorkerOptions } from './modules/jobs/worker';

/** Creates a worker with every background job handler registered. */
export function createWorker(ctx: AppContext, opts: WorkerOptions = {}) {
  const worker = new Worker(ctx, {
    concurrency: ctx.config.WORKER_CONCURRENCY,
    pollMs: ctx.config.WORKER_POLL_MS,
    ...opts,
  });
  worker.register(INGEST_JOB, ingestionHandler(ctx));
  return worker;
}
