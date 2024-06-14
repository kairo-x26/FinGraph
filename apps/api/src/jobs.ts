import type { AppContext } from './context';
import { reprocessOutdated, REPROCESS_OUTDATED_JOB } from './modules/extraction/routes';
import { classifyStage, extractStage, parseStage } from './modules/extraction/stages';
import { graphStage } from './modules/graph/build';
import { ingestionHandler, INGEST_JOB, scanStage, validateStage, type StageDefinition } from './modules/ingestion/pipeline';
import { Worker, type WorkerOptions } from './modules/jobs/worker';

/** The full ingestion pipeline, in order. */
export function ingestionStages(): StageDefinition[] {
  return [validateStage, scanStage, parseStage, classifyStage, extractStage, graphStage];
}

/** Creates a worker with every background job handler registered. */
export function createWorker(ctx: AppContext, opts: WorkerOptions = {}) {
  const worker = new Worker(ctx, {
    concurrency: ctx.config.WORKER_CONCURRENCY,
    pollMs: ctx.config.WORKER_POLL_MS,
    ...opts,
  });
  worker.register(INGEST_JOB, ingestionHandler(ctx, ingestionStages()));
  worker.register(REPROCESS_OUTDATED_JOB, async ({ job }) => ({
    queued: await ctx.db.tenant(job.tenant_id, (tx) => reprocessOutdated(tx, job.tenant_id)),
  }));
  return worker;
}
