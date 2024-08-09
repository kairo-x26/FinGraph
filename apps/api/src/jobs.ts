import type { AppContext } from './context';
import { reprocessOutdated, REPROCESS_OUTDATED_JOB } from './modules/extraction/routes';
import { classifyStage, extractStage, parseStage } from './modules/extraction/stages';
import { graphStage } from './modules/graph/build';
import { indexStage } from './modules/retrieval/index-stage';
import { ingestionHandler, INGEST_JOB, scanStage, validateStage, type StageDefinition } from './modules/ingestion/pipeline';
import { Worker, type WorkerOptions } from './modules/jobs/worker';
import { BUILD_EXPORT_JOB, exportHandler } from './modules/governance/exports';
import { activeHold, deleteObjects, purgeDocumentData, PURGE_DOCUMENT_JOB, RETENTION_SWEEP_JOB, runRetentionSweep } from './modules/governance/purge';
import { recordAudit } from './modules/audit/service';
import { Scheduler } from './modules/jobs/scheduler';

/** The full ingestion pipeline, in order. */
export function ingestionStages(): StageDefinition[] {
  return [validateStage, scanStage, parseStage, classifyStage, extractStage, indexStage, graphStage];
}

/** Creates a worker with every background job handler registered. */
export function createWorker(ctx: AppContext, opts: WorkerOptions = {}) {
  const worker = new Worker(ctx, {
    concurrency: ctx.config.WORKER_CONCURRENCY,
    pollMs: ctx.config.WORKER_POLL_MS,
    ...opts,
  });
  worker.register(INGEST_JOB, ingestionHandler(ctx, ingestionStages()));
  worker.register(BUILD_EXPORT_JOB, exportHandler(ctx));
  worker.register(RETENTION_SWEEP_JOB, async ({ job }) => runRetentionSweep(ctx, job.tenant_id));
  worker.register(PURGE_DOCUMENT_JOB, async ({ job }) => {
    const documentId = String(job.payload.document_id);
    const result = await ctx.db.tenant(job.tenant_id, async (tx) => {
      const d = await tx.one<{ case_id: string; purged_at: Date | null }>('select case_id, purged_at from documents where id = $1', [documentId]);
      if (!d || d.purged_at) return { skipped: 'already_purged' as const };
      if (await activeHold(tx, d.case_id, documentId)) return { skipped: 'legal_hold' as const };
      const r = await purgeDocumentData(tx, documentId);
      await recordAudit(tx, {
        tenantId: job.tenant_id,
        actor: { type: 'system', id: 'retention' },
        action: 'document.purged',
        resourceType: 'document',
        resourceId: documentId,
        details: { case_id: d.case_id, reason: job.payload.reason ?? null, ...r.counts },
      });
      return r;
    });
    if ('keys' in result) {
      await deleteObjects(ctx, result.keys);
      return result.counts;
    }
    return result;
  });
  worker.register(REPROCESS_OUTDATED_JOB, async ({ job }) => ({
    queued: await ctx.db.tenant(job.tenant_id, (tx) => reprocessOutdated(tx, job.tenant_id)),
  }));
  return worker;
}

const DAY = 86_400_000;

/** Periodic maintenance: retention sweeps daily, re-extraction with newer extractors weekly. */
export function createScheduler(ctx: AppContext) {
  return new Scheduler(ctx, [
    { task: 'retention', kind: RETENTION_SWEEP_JOB, everyMs: DAY },
    { task: 'reprocess-outdated', kind: REPROCESS_OUTDATED_JOB, everyMs: 7 * DAY },
  ]);
}
