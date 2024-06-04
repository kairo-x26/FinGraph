import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FACT_STATUSES, REVIEW_ACTIONS } from '@fingraph/shared';
import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { getVisibleCase, isClosed } from '../cases/access';
import { documentVisibleSql, getVisibleDocument } from '../documents/access';
import { registerDocument } from '../documents/routes';
import { emitEvent } from '../events/outbox';
import { INGEST_JOB } from '../ingestion/pipeline';
import { enqueue } from '../jobs/queue';
import { EXTRACTOR_VERSION, normalizeValue, type ValueType } from './schemas';

export interface FactRow {
  id: string;
  tenant_id: string;
  case_id: string;
  document_id: string;
  version_id: string;
  run_id: string;
  field_key: string;
  field_label: string;
  value_type: ValueType;
  value: unknown;
  value_text: string | null;
  group_key: string | null;
  confidence: number;
  critical: boolean;
  status: string;
  evidence_page: number | null;
  evidence_start: number | null;
  evidence_end: number | null;
  evidence_quote: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
}

const FACT_SELECT = `f.*, d.title as document_title, d.category as document_category, v.version_no,
  ru.display_name as reviewed_by_name`;

async function getVisibleFact(tx: Tx, auth: AuthContext, id: string, forUpdate = false) {
  const f = await tx.one<FactRow>(
    `select f.* from extracted_facts f join documents d on d.id = f.document_id
      where f.id = $1 and d.deleted_at is null and ${documentVisibleSql('d', '$2')} ${forUpdate ? 'for update of f' : ''}`,
    [id, auth.userId],
  );
  if (!f) throw notFound('Fact');
  return f;
}

export async function enqueueReprocess(tx: Tx, tenantId: string, versionId: string, userId: string | null, reason: string) {
  return enqueue(tx, {
    tenantId,
    kind: INGEST_JOB,
    payload: { version_id: versionId, reason },
    resource: { type: 'document_version', id: versionId },
    dedupeKey: `ingest:${versionId}`,
    createdBy: userId,
    priority: -1,
  });
}

export async function extractionRoutes(app: FastifyInstance) {
  route(app, {
    method: 'GET',
    url: '/v1/documents/:id/extractions',
    summary: 'Classification and proposed fields for the document’s current version',
    tags: ['extraction'],
    permission: 'document:read',
    scopes: ['documents:read'],
    params: uuidParam,
    query: z.object({ version_id: z.uuid().optional(), include_superseded: z.enum(['true', 'false']).default('false') }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        const versionId = query.version_id ?? d.current_version_id;
        const run = await t.one(
          `select id, category, classifier, classification, extractor, schema_version, coverage, created_at
             from extraction_runs where version_id = $1 order by created_at desc limit 1`,
          [versionId],
        );
        const facts = await t.many(
          `select ${FACT_SELECT} from extracted_facts f
             join documents d on d.id = f.document_id
             join document_versions v on v.id = f.version_id
             left join users ru on ru.id = f.reviewed_by
            where f.version_id = $1 ${query.include_superseded === 'true' ? '' : `and f.status <> 'superseded'`}
            order by f.group_key nulls first, f.created_at`,
          [versionId],
        );
        return { document_id: d.id, version_id: versionId, category: d.category, run: run ?? null, facts };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/facts',
    summary: 'Extracted facts across the case’s visible documents',
    tags: ['extraction'],
    permission: 'case:read',
    scopes: ['cases:read'],
    params: uuidParam,
    query: z.object({
      status: z
        .union([z.enum(FACT_STATUSES), z.array(z.enum(FACT_STATUSES))])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
      critical: z.enum(['true', 'false']).optional(),
    }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const where = [`f.case_id = $1`, `d.deleted_at is null`, documentVisibleSql('d', '$2'), `f.version_id = d.current_version_id`];
        const values: unknown[] = [params.id, auth.userId];
        if (query.status) {
          values.push(query.status);
          where.push(`f.status = any($${values.length})`);
        } else where.push(`f.status <> 'superseded'`);
        if (query.critical) where.push(`f.critical = ${query.critical === 'true'}`);
        const items = await t.many(
          `select ${FACT_SELECT} from extracted_facts f
             join documents d on d.id = f.document_id
             join document_versions v on v.id = f.version_id
             left join users ru on ru.id = f.reviewed_by
            where ${where.join(' and ')}
            order by d.created_at, f.group_key nulls first, f.created_at`,
          values,
        );
        const counts = items.reduce<Record<string, number>>((acc, f) => {
          acc[f.status] = (acc[f.status] ?? 0) + 1;
          return acc;
        }, {});
        return { items, counts };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/extracted-facts/:id',
    summary: 'A fact with its evidence context and review history',
    tags: ['extraction'],
    permission: 'document:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const f = await getVisibleFact(t, auth, params.id);
        const page = f.evidence_page
          ? await t.one<{ text: string }>('select text from document_pages where version_id = $1 and page_no = $2', [f.version_id, f.evidence_page])
          : undefined;
        const context =
          page && f.evidence_start !== null && f.evidence_end !== null
            ? {
                before: page.text.slice(Math.max(0, f.evidence_start - 200), f.evidence_start),
                match: page.text.slice(f.evidence_start, f.evidence_end),
                after: page.text.slice(f.evidence_end, f.evidence_end + 200),
              }
            : null;
        const history = await t.many(
          `select r.*, u.display_name as reviewer_name from fact_reviews r left join users u on u.id = r.reviewer_id
            where r.fact_id = $1 order by r.created_at`,
          [f.id],
        );
        return { ...f, context, history };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/extracted-facts/:id/reviews',
    summary: 'Approve, correct or reject an extracted fact',
    tags: ['extraction'],
    permission: 'fact:review',
    scopes: ['facts:review'],
    params: uuidParam,
    body: z
      .object({
        action: z.enum(REVIEW_ACTIONS),
        value: z.string().trim().min(1).max(1000).optional(),
        comment: z.string().trim().max(2000).optional(),
      })
      .superRefine((b, ctx) => {
        if (b.action === 'correct' && !b.value) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A corrected value is required.' });
        if (b.action !== 'approve' && (!b.comment || b.comment.length < 3)) {
          ctx.addIssue({ code: 'custom', path: ['comment'], message: 'Explain why the value is being changed.' });
        }
      }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const f = await getVisibleFact(t, auth, params.id, true);
        const c = await getVisibleCase(t, auth, f.case_id);
        if (isClosed(c)) throw conflict('Facts on a closed case cannot be changed.');
        if (f.status === 'superseded') throw conflict('This fact was superseded by a newer extraction.');
        if (f.status !== 'candidate') throw conflict(`This fact was already ${f.status}. Reopen it first.`);

        let newValue: unknown = f.value;
        let newText = f.value_text;
        if (body.action === 'correct') {
          const n = normalizeValue(f.value_type, body.value!);
          if (!n) throw unprocessable('invalid_value', `"${body.value}" is not a valid ${f.value_type}.`);
          newValue = n.value;
          newText = n.text;
        }
        const status = body.action === 'approve' ? 'approved' : body.action === 'correct' ? 'corrected' : 'rejected';
        await t.query(
          `insert into fact_reviews (tenant_id, fact_id, action, previous_status, previous_value, new_value, comment, reviewer_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [auth.tenantId, f.id, body.action, f.status, JSON.stringify(f.value), JSON.stringify(newValue), body.comment ?? null, auth.userId],
        );
        const updated = await t.one(
          `update extracted_facts set status = $2, value = $3, value_text = $4, reviewed_by = $5, reviewed_at = now()
            where id = $1 returning *`,
          [f.id, status, JSON.stringify(newValue), newText, auth.userId],
        );
        await audit(t, req, {
          action: `fact.${status}`,
          resourceType: 'fact',
          resourceId: f.id,
          details: {
            case_id: f.case_id,
            document_id: f.document_id,
            field: f.field_key,
            previous: f.value,
            value: newValue,
            comment: body.comment ?? null,
          },
        });
        await emitEvent(t, {
          tenantId: auth.tenantId,
          type: status === 'rejected' ? 'extraction.rejected' : 'extraction.approved',
          resource: { type: 'fact', id: f.id },
          data: { case_id: f.case_id, document_id: f.document_id, field_key: f.field_key, status },
          correlationId: req.id,
        });
        return updated;
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/extracted-facts/:id/reopen',
    summary: 'Return a reviewed fact to the review queue',
    tags: ['extraction'],
    permission: 'fact:review',
    params: uuidParam,
    body: z.object({ comment: z.string().trim().min(3).max(2000) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const f = await getVisibleFact(t, auth, params.id, true);
        const c = await getVisibleCase(t, auth, f.case_id);
        if (isClosed(c)) throw conflict('Facts on a closed case cannot be changed.');
        if (!['approved', 'corrected', 'rejected'].includes(f.status)) throw conflict('Only reviewed facts can be reopened.');
        await t.query(
          `insert into fact_reviews (tenant_id, fact_id, action, previous_status, previous_value, new_value, comment, reviewer_id)
           values ($1,$2,'reopen',$3,$4,$4,$5,$6)`,
          [auth.tenantId, f.id, f.status, JSON.stringify(f.value), body.comment, auth.userId],
        );
        const updated = await t.one(`update extracted_facts set status = 'candidate', reviewed_by = null, reviewed_at = null where id = $1 returning *`, [f.id]);
        await audit(t, req, {
          action: 'fact.reopened',
          resourceType: 'fact',
          resourceId: f.id,
          details: { case_id: f.case_id, previous_status: f.status, comment: body.comment },
        });
        return updated;
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/documents/:id/pages',
    summary: 'Extracted page text and layout for the document viewer',
    tags: ['extraction'],
    permission: 'document:read',
    params: uuidParam,
    query: z.object({ version_id: z.uuid().optional() }),
    handler: async ({ params, query, auth, req, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        const versionId = query.version_id ?? d.current_version_id;
        const v = await t.one('select id from document_versions where id = $1 and document_id = $2', [versionId, d.id]);
        if (!v) throw notFound('Document version');
        const pages = await t.many(
          `select page_no, text, lines, width, height, ocr, ocr_confidence, needs_ocr
             from document_pages where version_id = $1 order by page_no`,
          [versionId],
        );
        await audit(t, req, {
          action: 'document.viewed',
          resourceType: 'document',
          resourceId: d.id,
          details: { case_id: d.case_id, version_id: versionId },
        });
        return { document_id: d.id, version_id: versionId, pages };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/documents/:id/reprocess',
    summary: 'Re-run processing for the current version (creates a new extraction run)',
    tags: ['extraction'],
    permission: 'document:upload',
    status: 202,
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        const job = await enqueueReprocess(t, auth.tenantId, d.current_version_id!, auth.userId, 'manual');
        await audit(t, req, {
          action: 'document.reprocess_requested',
          resourceType: 'document',
          resourceId: d.id,
          details: { case_id: d.case_id, job_id: job.id },
        });
        return { job_id: job.id, status_url: `/v1/ingestion-jobs/${job.id}` };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/reprocess',
    summary: 'Re-run processing for every document in a case',
    tags: ['extraction'],
    permission: 'document:upload',
    status: 202,
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id);
        const docs = await t.many<{ id: string; current_version_id: string }>(
          `select d.id, d.current_version_id from documents d join document_versions v on v.id = d.current_version_id
            where d.case_id = $1 and d.deleted_at is null and v.status = 'processed' and ${documentVisibleSql('d', '$2')}`,
          [c.id, auth.userId],
        );
        const jobs = [];
        for (const d of docs) jobs.push((await enqueueReprocess(t, auth.tenantId, d.current_version_id, auth.userId, 'case')).id);
        await audit(t, req, { action: 'case.reprocess_requested', resourceType: 'case', resourceId: c.id, details: { jobs: jobs.length } });
        return { job_ids: jobs };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/admin/reprocess-outdated',
    summary: 'Queue reprocessing for documents extracted with an older extractor version',
    tags: ['admin'],
    permission: 'admin:settings',
    status: 202,
    handler: async ({ auth, req, tx }) =>
      tx(async (t) => {
        const job = await enqueue(t, {
          tenantId: auth.tenantId,
          kind: REPROCESS_OUTDATED_JOB,
          dedupeKey: 'reprocess-outdated',
          createdBy: auth.userId,
        });
        await audit(t, req, { action: 'tenant.reprocess_outdated', resourceType: 'tenant', resourceId: auth.tenantId, details: { job_id: job.id } });
        return { job_id: job.id };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/documents/batch',
    summary: 'Register several uploaded files at once (batch import)',
    tags: ['documents'],
    permission: 'document:upload',
    scopes: ['documents:write'],
    status: 202,
    body: z.object({ items: z.array(z.object({ upload_id: z.uuid(), title: z.string().trim().min(1).max(200).optional() })).min(1).max(100) }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const results = [];
        for (const item of body.items) {
          const up = await t.one<{
            id: string;
            case_id: string;
            filename: string;
            declared_mime_type: string;
            detected_mime_type: string | null;
            size_bytes: number | null;
            sha256: string | null;
            storage_key: string;
            uploaded_at: Date | null;
            consumed_at: Date | null;
          }>('select * from upload_sessions where id = $1 for update', [item.upload_id]);
          if (!up || up.consumed_at || !up.uploaded_at || !up.sha256) {
            results.push({ upload_id: item.upload_id, status: 'error', code: 'upload_not_ready' });
            continue;
          }
          const c = await getVisibleCase(t, auth, up.case_id);
          if (isClosed(c) || up.detected_mime_type !== up.declared_mime_type) {
            results.push({ upload_id: item.upload_id, status: 'error', code: isClosed(c) ? 'case_closed' : 'file_type_mismatch' });
            continue;
          }
          await t.query('update upload_sessions set consumed_at = now() where id = $1', [up.id]);
          const r = await registerDocument(t, {
            tenantId: auth.tenantId,
            caseId: up.case_id,
            filename: up.filename,
            mimeType: up.detected_mime_type,
            sizeBytes: up.size_bytes!,
            sha256: up.sha256,
            storageKey: up.storage_key,
            title: item.title,
            source: 'batch',
            userId: auth.userId,
            correlationId: req.id,
          });
          results.push(
            r.duplicate
              ? { upload_id: item.upload_id, status: 'duplicate', document_id: r.document_id }
              : { upload_id: item.upload_id, status: 'queued', document_id: r.document.id, job_id: r.job.id },
          );
        }
        await audit(t, req, {
          action: 'document.batch_imported',
          resourceType: 'batch',
          resourceId: null,
          details: { items: results.length, queued: results.filter((r) => r.status === 'queued').length },
        });
        return { items: results };
      }),
  });
}

/** Job: re-queue processed versions whose last extraction used an older extractor (DOC-08). */
export const REPROCESS_OUTDATED_JOB = 'reprocess_outdated';

export async function reprocessOutdated(tx: Tx, tenantId: string, limit = 500) {
  const rows = await tx.many<{ version_id: string }>(
    `select v.id as version_id from documents d
       join document_versions v on v.id = d.current_version_id
       left join lateral (select extractor from extraction_runs r where r.version_id = v.id order by created_at desc limit 1) r on true
      where d.deleted_at is null and v.status = 'processed' and v.purged_at is null
        and (r.extractor is null or r.extractor <> $1)
      limit $2`,
    [EXTRACTOR_VERSION, limit],
  );
  for (const r of rows) await enqueueReprocess(tx, tenantId, r.version_id, null, 'scheduled');
  return rows.length;
}

