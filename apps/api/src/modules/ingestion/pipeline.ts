import type { IngestionStage } from '@fingraph/shared';
import type { AppContext } from '../../context';
import type { Tx } from '../../db';
import { sha256Hex } from '../../lib/crypto';
import { recordAudit } from '../audit/service';
import { emitEvent } from '../events/outbox';
import { detectMime, isSupportedMime, mimeMatches } from '../documents/filetypes';
import { classifyError, PermanentJobError } from '../jobs/errors';
import type { JobContext } from '../jobs/worker';

export const INGEST_JOB = 'ingest_document';

export interface VersionRow {
  id: string;
  tenant_id: string;
  document_id: string;
  version_no: number;
  storage_key: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  status: string;
  source: string;
  page_count: number | null;
  created_at: Date;
}

export interface DocumentRow {
  id: string;
  tenant_id: string;
  case_id: string;
  title: string;
  category: string | null;
  category_source: string | null;
  current_version_id: string | null;
  restricted: boolean;
}

/** Shared state passed between stages for one run. */
export interface StageState {
  ctx: AppContext;
  job: JobContext['job'];
  version: VersionRow;
  document: DocumentRow;
  data?: Buffer;
  /** Arbitrary outputs from earlier stages in this run. */
  outputs: Partial<Record<IngestionStage, unknown>>;
  tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
  /** Set by a stage to end the pipeline early with a terminal outcome (e.g. quarantine). */
  halt?: { status: 'quarantined' | 'rejected'; reason: string };
}

export interface StageDefinition {
  stage: IngestionStage;
  processor: string;
  version: string;
  run: (s: StageState) => Promise<Record<string, unknown> | void>;
  /** Stages whose output is persisted can be skipped when a retry re-runs the job. */
  resumable?: boolean;
}

async function loadBytes(s: StageState) {
  if (!s.data) s.data = await s.ctx.storage.get(s.version.storage_key);
  return s.data;
}

export const validateStage: StageDefinition = {
  stage: 'validate',
  processor: 'fingraph-validator',
  version: '1.0',
  run: async (s) => {
    const data = await loadBytes(s);
    if (sha256Hex(data) !== s.version.sha256) {
      throw new PermanentJobError('integrity_error', 'Stored object does not match the recorded checksum');
    }
    if (data.length > s.ctx.config.MAX_UPLOAD_BYTES) {
      s.halt = { status: 'rejected', reason: 'file_too_large' };
      return { size: data.length };
    }
    const detected = detectMime(data);
    if (!isSupportedMime(detected) || !mimeMatches(s.version.mime_type, detected)) {
      s.halt = { status: 'rejected', reason: 'unsupported_or_mismatched_type' };
      return { detected };
    }
    return { detected, size: data.length };
  },
};

export const scanStage: StageDefinition = {
  stage: 'scan',
  processor: 'malware-scanner',
  version: '1.0',
  run: async (s) => {
    const data = await loadBytes(s);
    const result = await s.ctx.scanner.scan(data, s.version.mime_type);
    await s.tx((t) =>
      t.query('update document_versions set scan_result = $2 where id = $1', [s.version.id, JSON.stringify(result)]),
    );
    if (!result.clean) s.halt = { status: 'quarantined', reason: `malware:${result.threats.join(',')}` };
    return { clean: result.clean, threats: result.threats, warnings: result.warnings, engine: result.engine };
  },
};

/** Ordered ingestion stages. */
export const PIPELINE: StageDefinition[] = [validateStage, scanStage];

async function recordStage(
  tx: Tx,
  s: StageState,
  def: StageDefinition,
  row: { status: string; started: number; output?: unknown; errorType?: string; errorMessage?: string },
) {
  await tx.query(
    `insert into job_stages (tenant_id, job_id, attempt, stage, status, processor, processor_version, input_version_id,
                             error_type, error_message, output, started_at, finished_at, duration_ms)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,to_timestamp($12 / 1000.0), now(), $13)`,
    [
      s.version.tenant_id,
      s.job.id,
      s.job.attempts,
      def.stage,
      row.status,
      def.processor,
      def.version,
      s.version.id,
      row.errorType ?? null,
      row.errorMessage?.slice(0, 2000) ?? null,
      row.output === undefined ? null : JSON.stringify(row.output),
      row.started,
      Date.now() - row.started,
    ],
  );
}

async function setVersionStatus(tx: Tx, versionId: string, status: string, extra: { error?: unknown } = {}) {
  await tx.query(
    `update document_versions set status = $2, error = $3,
            processed_at = case when $2 = 'processed' then now() else processed_at end
      where id = $1`,
    [versionId, status, extra.error === undefined ? null : JSON.stringify(extra.error)],
  );
}

/** Job handler for `ingest_document`. Idempotent: safe to run again for the same version. */
export function ingestionHandler(ctx: AppContext, stages: StageDefinition[] = PIPELINE) {
  return async ({ job, heartbeat }: JobContext) => {
    const versionId = String(job.payload.version_id);
    const tx = <T>(fn: (t: Tx) => Promise<T>) => ctx.db.tenant(job.tenant_id, fn);
    const loaded = await tx(async (t) => {
      const version = await t.one<VersionRow>('select * from document_versions where id = $1', [versionId]);
      if (!version) return null;
      const document = await t.one<DocumentRow>('select * from documents where id = $1', [version.document_id]);
      return { version, document: document! };
    });
    if (!loaded) throw new PermanentJobError('not_found', `document version ${versionId} not found`);
    if (['quarantined', 'rejected'].includes(loaded.version.status)) return { outcome: loaded.version.status, skipped: true };

    const s: StageState = { ctx, job, version: loaded.version, document: loaded.document, outputs: {}, tx };

    const completed = new Set(
      (
        await tx((t) =>
          t.many<{ stage: string }>(
            `select stage from job_stages where job_id = $1 and status = 'succeeded' and attempt < $2`,
            [job.id, job.attempts],
          ),
        )
      ).map((r) => r.stage),
    );

    await tx(async (t) => {
      await setVersionStatus(t, versionId, 'processing');
      if (job.attempts === 1) {
        await emitEvent(t, {
          tenantId: job.tenant_id,
          type: 'document.processing_started',
          resource: { type: 'document', id: s.document.id },
          data: { version_id: versionId, case_id: s.document.case_id },
        });
      }
    });

    try {
      for (const def of stages) {
        const started = Date.now();
        if (def.resumable && completed.has(def.stage)) {
          await tx((t) => recordStage(t, s, def, { status: 'skipped', started }));
          continue;
        }
        let output: unknown;
        try {
          output = await def.run(s);
        } catch (err) {
          const e = classifyError(err);
          await tx((t) => recordStage(t, s, def, { status: 'failed', started, errorType: e.type, errorMessage: e.message }));
          throw err;
        }
        s.outputs[def.stage] = output;
        await tx((t) => recordStage(t, s, def, { status: 'succeeded', started, output }));
        await heartbeat();
        if (s.halt) break;
      }
    } catch (err) {
      const e = classifyError(err);
      const terminal = !e.retryable || job.attempts >= job.max_attempts;
      if (terminal) {
        await tx(async (t) => {
          await setVersionStatus(t, versionId, 'failed', { error: { type: e.type, message: e.message } });
          await emitEvent(t, {
            tenantId: job.tenant_id,
            type: 'document.processing_failed',
            resource: { type: 'document', id: s.document.id },
            data: { version_id: versionId, case_id: s.document.case_id, error_type: e.type, attempts: job.attempts },
          });
          await recordAudit(t, {
            tenantId: job.tenant_id,
            actor: { type: 'system', id: 'ingestion' },
            action: 'document.processing_failed',
            resourceType: 'document',
            resourceId: s.document.id,
            details: { version_id: versionId, case_id: s.document.case_id, error_type: e.type },
          });
        });
      } else {
        await tx((t) => setVersionStatus(t, versionId, 'queued', { error: { type: e.type, message: e.message, retrying: true } }));
      }
      throw err;
    }

    if (s.halt) {
      const halt = s.halt;
      await tx(async (t) => {
        await setVersionStatus(t, versionId, halt.status, { error: { type: halt.reason } });
        await emitEvent(t, {
          tenantId: job.tenant_id,
          type: 'document.validation_failed',
          resource: { type: 'document', id: s.document.id },
          data: { version_id: versionId, case_id: s.document.case_id, outcome: halt.status, reason: halt.reason },
        });
        await recordAudit(t, {
          tenantId: job.tenant_id,
          actor: { type: 'system', id: 'ingestion' },
          action: halt.status === 'quarantined' ? 'document.quarantined' : 'document.rejected',
          resourceType: 'document',
          resourceId: s.document.id,
          details: { version_id: versionId, case_id: s.document.case_id, reason: halt.reason },
        });
      });
      return { outcome: halt.status, reason: halt.reason };
    }

    await tx(async (t) => {
      await setVersionStatus(t, versionId, 'processed');
      // A replacement only becomes current once it processed successfully.
      await t.query('update documents set current_version_id = $2 where id = $1', [s.document.id, versionId]);
      await emitEvent(t, {
        tenantId: job.tenant_id,
        type: 'document.processed',
        resource: { type: 'document', id: s.document.id },
        data: { version_id: versionId, case_id: s.document.case_id, version_no: s.version.version_no },
      });
    });
    return { outcome: 'processed', stages: Object.keys(s.outputs) };
  };
}
