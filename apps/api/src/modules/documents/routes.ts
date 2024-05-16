import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_CATEGORIES } from '@fingraph/shared';
import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { hmacHex, safeEqual, sha256Hex } from '../../lib/crypto';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { getVisibleCase, isClosed } from '../cases/access';
import { emitEvent } from '../events/outbox';
import { settingsOf, type TenantRow } from '../identity/tenants';
import { INGEST_JOB, type DocumentRow, type VersionRow } from '../ingestion/pipeline';
import { enqueue, retryJob, type JobRow } from '../jobs/queue';
import { documentVisibleSql, getVisibleDocument } from './access';
import { detectMime, isSupportedMime, mimeMatches, safeFilename, SUPPORTED_TYPES } from './filetypes';

const UPLOAD_TTL_SEC = 15 * 60;

export function uploadSignature(secret: string, uploadId: string, expires: number) {
  return hmacHex(secret, `upload:${uploadId}:${expires}`);
}

interface UploadRow {
  id: string;
  tenant_id: string;
  case_id: string;
  filename: string;
  declared_mime_type: string;
  declared_size: number;
  storage_key: string;
  sha256: string | null;
  size_bytes: number | null;
  detected_mime_type: string | null;
  expires_at: Date;
  uploaded_at: Date | null;
  consumed_at: Date | null;
}

async function assertDailyQuota(tx: Tx, tenantId: string) {
  const tenant = await tx.one<TenantRow>('select * from tenants where id = $1', [tenantId]);
  const quota = settingsOf(tenant!).quotas.documents_per_day;
  const used = await tx.one<{ n: number }>(
    `select count(*)::int as n from document_versions where created_at > now() - interval '1 day'`,
  );
  if (used!.n >= quota) {
    throw new AppError(429, 'quota_exceeded', `The organization has reached its limit of ${quota} documents per day.`);
  }
}

export interface RegisterInput {
  tenantId: string;
  caseId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  title?: string;
  restricted?: boolean;
  replacesDocumentId?: string;
  replacedReason?: string;
  source: 'upload' | 'connector' | 'batch' | 'api';
  sourceRef?: string | null;
  userId: string | null;
  correlationId?: string | null;
}

export type RegisterResult =
  | { duplicate: true; document_id: string; version_id: string }
  | { duplicate: false; document: DocumentRow; version: VersionRow; job: JobRow };

/**
 * Creates a document (or a new version of an existing one) and queues ingestion.
 * Identical content already in the same case is linked instead of stored twice.
 */
export async function registerDocument(tx: Tx, input: RegisterInput): Promise<RegisterResult> {
  await assertDailyQuota(tx, input.tenantId);

  const sameCase = await tx.one<{ document_id: string; version_id: string }>(
    `select d.id as document_id, v.id as version_id
       from document_versions v join documents d on d.id = v.document_id
      where v.sha256 = $1 and d.case_id = $2 and d.deleted_at is null
        and v.status not in ('rejected', 'quarantined')
      limit 1`,
    [input.sha256, input.caseId],
  );
  if (sameCase) return { duplicate: true, ...sameCase };

  const elsewhere = await tx.one<{ id: string }>(
    `select v.id from document_versions v where v.sha256 = $1 and v.status = 'processed' order by v.created_at limit 1`,
    [input.sha256],
  );

  let document: DocumentRow;
  let versionNo = 1;
  if (input.replacesDocumentId) {
    const existing = await tx.one<DocumentRow>(
      'select * from documents where id = $1 and case_id = $2 and deleted_at is null for update',
      [input.replacesDocumentId, input.caseId],
    );
    if (!existing) throw notFound('Document');
    document = existing;
    const last = await tx.one<{ n: number }>('select max(version_no)::int as n from document_versions where document_id = $1', [
      existing.id,
    ]);
    versionNo = (last?.n ?? 0) + 1;
  } else {
    document = (await tx.one<DocumentRow>(
      `insert into documents (tenant_id, case_id, title, restricted, created_by) values ($1,$2,$3,$4,$5) returning *`,
      [input.tenantId, input.caseId, input.title ?? input.filename.replace(/\.[a-z0-9]+$/i, ''), input.restricted ?? false, input.userId],
    ))!;
  }

  const version = (await tx.one<VersionRow>(
    `insert into document_versions (tenant_id, document_id, version_no, storage_key, filename, mime_type, size_bytes, sha256,
                                    status, source, source_ref, duplicate_of_version_id, replaced_reason, uploaded_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'queued',$9,$10,$11,$12,$13) returning *`,
    [
      input.tenantId,
      document.id,
      versionNo,
      input.storageKey,
      input.filename,
      input.mimeType,
      input.sizeBytes,
      input.sha256,
      input.source,
      input.sourceRef ?? null,
      elsewhere?.id ?? null,
      input.replacedReason ?? null,
      input.userId,
    ],
  ))!;
  if (!document.current_version_id) {
    await tx.query('update documents set current_version_id = $2 where id = $1', [document.id, version.id]);
    document.current_version_id = version.id;
  }

  const job = await enqueue(tx, {
    tenantId: input.tenantId,
    kind: INGEST_JOB,
    payload: { version_id: version.id },
    resource: { type: 'document_version', id: version.id },
    dedupeKey: `ingest:${version.id}`,
    createdBy: input.userId,
  });

  await emitEvent(tx, {
    tenantId: input.tenantId,
    type: 'document.uploaded',
    resource: { type: 'document', id: document.id },
    data: { version_id: version.id, case_id: input.caseId, version_no: versionNo, source: input.source, sha256: input.sha256 },
    correlationId: input.correlationId,
  });
  return { duplicate: false, document, version, job };
}

const DOC_SELECT = `
  d.id, d.case_id, d.title, d.category, d.category_confidence, d.category_source, d.restricted, d.evidence_date,
  d.current_version_id, d.created_at, d.updated_at, d.created_by,
  v.version_no, v.filename, v.mime_type, v.size_bytes, v.sha256, v.status, v.page_count, v.source,
  v.scan_result, v.error, v.created_at as version_created_at, v.processed_at,
  (select lv.status from document_versions lv where lv.document_id = d.id order by lv.version_no desc limit 1) as latest_status,
  (select max(lv.version_no) from document_versions lv where lv.document_id = d.id) as latest_version_no`;

export async function documentRoutes(app: FastifyInstance) {
  const { config, storage } = app.ctx;

  // Raw bodies for the signed upload endpoint.
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: config.MAX_UPLOAD_BYTES }, (_req, body, done) =>
    done(null, body),
  );

  route(app, {
    method: 'POST',
    url: '/v1/documents/uploads',
    summary: 'Obtain a short-lived URL to upload a file for a case',
    tags: ['documents'],
    permission: 'document:upload',
    scopes: ['documents:write'],
    status: 201,
    body: z.object({
      case_id: z.uuid(),
      filename: z.string().min(1).max(255),
      mime_type: z.string().max(200),
      size_bytes: z.number().int().positive(),
    }),
    handler: async ({ body, auth, tx }) => {
      if (!isSupportedMime(body.mime_type)) {
        throw unprocessable('unsupported_file_type', 'This file type is not supported.', {
          supported: Object.keys(SUPPORTED_TYPES),
        });
      }
      if (body.size_bytes > config.MAX_UPLOAD_BYTES) {
        throw unprocessable('file_too_large', `Files must be ${Math.floor(config.MAX_UPLOAD_BYTES / 1024 / 1024)} MB or smaller.`);
      }
      return tx(async (t) => {
        const c = await getVisibleCase(t, auth, body.case_id);
        if (isClosed(c)) throw conflict('Documents cannot be added to a closed case.');
        const row = await t.one<UploadRow>(
          `insert into upload_sessions (tenant_id, case_id, filename, declared_mime_type, declared_size, storage_key, created_by, expires_at)
           values ($1,$2,$3,$4,$5,'pending',$6, now() + make_interval(secs => $7)) returning *`,
          [auth.tenantId, c.id, safeFilename(body.filename), body.mime_type, body.size_bytes, auth.userId, UPLOAD_TTL_SEC],
        );
        const key = `tenants/${auth.tenantId}/cases/${c.id}/uploads/${row!.id}`;
        await t.query('update upload_sessions set storage_key = $2 where id = $1', [row!.id, key]);
        const expires = Math.floor(new Date(row!.expires_at).getTime() / 1000);
        const sig = uploadSignature(config.APP_SECRET, row!.id, expires);
        return {
          upload_id: row!.id,
          method: 'PUT',
          upload_url: `${config.PUBLIC_API_URL}/v1/uploads/${row!.id}?expires=${expires}&sig=${sig}`,
          headers: { 'content-type': 'application/octet-stream' },
          expires_at: row!.expires_at,
        };
      });
    },
  });

  route(app, {
    method: 'PUT',
    url: '/v1/uploads/:id',
    summary: 'Upload file bytes to a signed upload URL',
    tags: ['documents'],
    auth: 'none',
    rawBody: true,
    params: uuidParam,
    query: z.object({ expires: z.coerce.number().int(), sig: z.string().length(64) }),
    handler: async ({ params, query, req }) => {
      const expected = uploadSignature(config.APP_SECRET, params.id, query.expires);
      if (!safeEqual(expected, query.sig) || query.expires * 1000 < Date.now()) {
        throw new AppError(403, 'invalid_upload_url', 'The upload URL is invalid or has expired.');
      }
      const body = req.body;
      if (!Buffer.isBuffer(body) || body.length === 0) throw unprocessable('empty_file', 'The uploaded file is empty.');
      const session = await app.ctx.db.system((t) =>
        t.one<UploadRow>('select * from upload_sessions where id = $1', [params.id]),
      );
      if (!session || session.uploaded_at) throw new AppError(403, 'invalid_upload_url', 'The upload URL is invalid or has expired.');
      if (body.length > session.declared_size || body.length > config.MAX_UPLOAD_BYTES) {
        throw unprocessable('file_too_large', 'The file is larger than declared.');
      }
      const sha256 = sha256Hex(body);
      const detected = detectMime(body);
      await storage.put(session.storage_key, body, { contentType: session.declared_mime_type });
      await app.ctx.db.tenant(session.tenant_id, (t) =>
        t.query(
          `update upload_sessions set uploaded_at = now(), sha256 = $2, size_bytes = $3, detected_mime_type = $4 where id = $1`,
          [session.id, sha256, body.length, detected],
        ),
      );
      return { upload_id: session.id, sha256, size_bytes: body.length };
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/documents',
    summary: 'Register an uploaded file as a document (or new version) and start processing',
    tags: ['documents'],
    permission: 'document:upload',
    scopes: ['documents:write'],
    body: z.object({
      upload_id: z.uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      restricted: z.boolean().optional(),
      replaces_document_id: z.uuid().optional(),
      replaced_reason: z.string().trim().max(500).optional(),
    }),
    responses: { 202: { description: 'Accepted for processing' } },
    handler: async ({ body, auth, req, reply, tx }) => {
      const result = await tx(async (t) => {
        const up = await t.one<UploadRow>('select * from upload_sessions where id = $1 for update', [body.upload_id]);
        if (!up || up.consumed_at) throw notFound('Upload');
        if (!up.uploaded_at || !up.sha256) throw conflict('The file has not been uploaded yet.');
        const c = await getVisibleCase(t, auth, up.case_id);
        if (isClosed(c)) throw conflict('Documents cannot be added to a closed case.');
        if (body.replaces_document_id) await getVisibleDocument(t, auth, body.replaces_document_id);

        const detected = up.detected_mime_type ?? 'application/octet-stream';
        const reason = !isSupportedMime(detected)
          ? 'unsupported_file_type'
          : !mimeMatches(up.declared_mime_type, detected)
            ? 'file_type_mismatch'
            : null;
        if (reason || !isSupportedMime(detected)) {
          await t.query('update upload_sessions set consumed_at = now() where id = $1', [up.id]);
          await emitEvent(t, {
            tenantId: auth.tenantId,
            type: 'document.validation_failed',
            resource: { type: 'upload', id: up.id },
            data: { case_id: up.case_id, reason, filename: up.filename, declared: up.declared_mime_type, detected },
            correlationId: req.id,
          });
          await audit(t, req, {
            action: 'document.rejected',
            resourceType: 'upload',
            resourceId: up.id,
            details: { case_id: up.case_id, reason, declared: up.declared_mime_type, detected },
          });
          return { rejected: reason ?? 'unsupported_file_type' };
        }

        await t.query('update upload_sessions set consumed_at = now() where id = $1', [up.id]);
        const r = await registerDocument(t, {
          tenantId: auth.tenantId,
          caseId: up.case_id,
          filename: up.filename,
          mimeType: detected,
          sizeBytes: up.size_bytes!,
          sha256: up.sha256,
          storageKey: up.storage_key,
          title: body.title,
          restricted: body.restricted,
          replacesDocumentId: body.replaces_document_id,
          replacedReason: body.replaced_reason,
          source: auth.kind === 'api_client' ? 'api' : 'upload',
          userId: auth.userId,
          correlationId: req.id,
        });
        await audit(t, req, {
          action: r.duplicate ? 'document.duplicate_linked' : body.replaces_document_id ? 'document.version_added' : 'document.uploaded',
          resourceType: 'document',
          resourceId: r.duplicate ? r.document_id : r.document.id,
          details: {
            case_id: up.case_id,
            filename: up.filename,
            sha256: up.sha256,
            version_id: r.duplicate ? r.version_id : r.version.id,
          },
        });
        return r;
      });

      if ('rejected' in result) {
        throw result.rejected === 'file_type_mismatch'
          ? unprocessable('file_type_mismatch', 'The file content does not match its declared type.')
          : unprocessable('unsupported_file_type', 'The file content is not a supported document type.');
      }
      if (result.duplicate) {
        reply.code(200);
        return { duplicate: true, document_id: result.document_id, version_id: result.version_id, status: 'duplicate' };
      }
      reply.code(202);
      return {
        document_id: result.document.id,
        version_id: result.version.id,
        job_id: result.job.id,
        status: 'queued',
        case_id: result.document.case_id,
        status_url: `/v1/ingestion-jobs/${result.job.id}`,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/documents',
    summary: 'List documents in a case',
    tags: ['documents'],
    permission: 'document:read',
    scopes: ['documents:read'],
    query: z.object({ case_id: z.uuid() }),
    handler: async ({ query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, query.case_id);
        const items = await t.many(
          `select ${DOC_SELECT} from documents d join document_versions v on v.id = d.current_version_id
            where d.case_id = $1 and d.deleted_at is null and ${documentVisibleSql('d', '$2')}
            order by d.created_at`,
          [query.case_id, auth.userId],
        );
        return { items };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/documents/:id',
    summary: 'Retrieve a document with its version history',
    tags: ['documents'],
    permission: 'document:read',
    scopes: ['documents:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleDocument(t, auth, params.id);
        const doc = await t.one(
          `select ${DOC_SELECT} from documents d join document_versions v on v.id = d.current_version_id where d.id = $1`,
          [params.id],
        );
        const versions = await t.many(
          `select v.id, v.version_no, v.filename, v.mime_type, v.size_bytes, v.sha256, v.status, v.source, v.page_count,
                  v.duplicate_of_version_id, v.replaced_reason, v.scan_result, v.error, v.created_at, v.processed_at,
                  v.purged_at, u.display_name as uploaded_by_name
             from document_versions v left join users u on u.id = v.uploaded_by
            where v.document_id = $1 order by v.version_no desc`,
          [params.id],
        );
        const grants = await t.many(
          `select g.user_id, u.display_name from document_grants g join users u on u.id = g.user_id where g.document_id = $1`,
          [params.id],
        );
        return { ...doc, versions, grants };
      }),
  });

  route(app, {
    method: 'PATCH',
    url: '/v1/documents/:id',
    summary: 'Rename, reclassify or restrict a document',
    tags: ['documents'],
    permission: 'document:upload',
    params: uuidParam,
    body: z
      .object({
        title: z.string().trim().min(1).max(200),
        category: z.enum(DOCUMENT_CATEGORIES),
        restricted: z.boolean(),
      })
      .partial(),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const before = await getVisibleDocument(t, auth, params.id);
        const d = await t.one(
          `update documents set title = coalesce($2, title),
                  category = coalesce($3, category),
                  category_source = case when $3::text is not null then 'user' else category_source end,
                  category_confidence = case when $3::text is not null then 1 else category_confidence end,
                  restricted = coalesce($4, restricted)
            where id = $1 returning *`,
          [params.id, body.title ?? null, body.category ?? null, body.restricted ?? null],
        );
        if (body.restricted && !before.restricted) {
          // the person restricting a document keeps access
          await t.query(
            `insert into document_grants (tenant_id, document_id, user_id, granted_by) values ($1,$2,$3,$3) on conflict do nothing`,
            [auth.tenantId, params.id, auth.userId],
          );
        }
        await audit(t, req, {
          action: 'document.updated',
          resourceType: 'document',
          resourceId: params.id,
          details: { case_id: before.case_id, changes: body, previous_category: before.category },
        });
        return d;
      }),
  });

  route(app, {
    method: 'PUT',
    url: '/v1/documents/:id/grants/:userId',
    summary: 'Grant a user access to a restricted document',
    tags: ['documents'],
    permission: 'case:assign',
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        const u = await t.one(`select id from users where id = $1 and status = 'active'`, [params.userId]);
        if (!u) throw notFound('User');
        await t.query(
          `insert into document_grants (tenant_id, document_id, user_id, granted_by) values ($1,$2,$3,$4) on conflict do nothing`,
          [auth.tenantId, params.id, params.userId, auth.userId],
        );
        await audit(t, req, {
          action: 'document.access_granted',
          resourceType: 'document',
          resourceId: params.id,
          details: { case_id: d.case_id, user_id: params.userId },
        });
        return { document_id: params.id, user_id: params.userId };
      }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/documents/:id/grants/:userId',
    summary: 'Revoke a user’s access to a restricted document',
    tags: ['documents'],
    permission: 'case:assign',
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        await t.query('delete from document_grants where document_id = $1 and user_id = $2', [params.id, params.userId]);
        await audit(t, req, {
          action: 'document.access_revoked',
          resourceType: 'document',
          resourceId: params.id,
          details: { case_id: d.case_id, user_id: params.userId },
        });
      }),
  });

  async function streamVersion(t: Tx, auth: AuthContext, documentId: string, versionId: string | null) {
    const d = await getVisibleDocument(t, auth, documentId);
    const v = await t.one<VersionRow & { purged_at: Date | null }>(
      'select * from document_versions where document_id = $1 and id = $2',
      [documentId, versionId ?? d.current_version_id],
    );
    if (!v) throw notFound('Document version');
    if (v.status === 'quarantined') throw new AppError(403, 'quarantined', 'This file was quarantined by the malware scanner.');
    if (v.purged_at) throw new AppError(410, 'purged', 'This file was deleted under the retention policy.');
    return { d, v };
  }

  for (const url of ['/v1/documents/:id/content', '/v1/documents/:id/versions/:versionId/content']) {
    route(app, {
      method: 'GET',
      url,
      summary: 'Download a document version',
      tags: ['documents'],
      permission: 'document:download',
      scopes: ['documents:read'],
      params: z.object({ id: z.uuid(), versionId: z.uuid().optional() }),
      query: z.object({ disposition: z.enum(['inline', 'attachment']).default('attachment') }),
      handler: async ({ params, query, auth, req, reply, tx }) => {
        const { v, d } = await tx(async (t) => {
          const found = await streamVersion(t, auth, params.id, params.versionId ?? null);
          await audit(t, req, {
            action: 'document.downloaded',
            resourceType: 'document',
            resourceId: params.id,
            details: { case_id: found.d.case_id, version_id: found.v.id },
          });
          return found;
        });
        const data = await storage.get(v.storage_key);
        const inline = query.disposition === 'inline' && (v.mime_type === 'application/pdf' || v.mime_type.startsWith('image/'));
        reply
          .header('content-type', v.mime_type)
          .header('content-length', data.length)
          .header(
            'content-disposition',
            `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(v.filename)}"; filename*=UTF-8''${encodeURIComponent(v.filename)}`,
          )
          .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
          .header('x-document-sha256', v.sha256)
          .header('x-document-title', encodeURIComponent(d.title))
          .header('cache-control', 'private, no-store');
        return reply.send(data);
      },
    });
  }

  route(app, {
    method: 'DELETE',
    url: '/v1/documents/:id',
    summary: 'Delete a document (soft delete; blocked by legal holds)',
    tags: ['documents'],
    permission: 'document:delete',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        await t.query('update documents set deleted_at = now() where id = $1', [params.id]);
        await audit(t, req, {
          action: 'document.deleted',
          resourceType: 'document',
          resourceId: params.id,
          details: { case_id: d.case_id, reason: body.reason },
        });
      }),
  });

  // ---- ingestion jobs

  async function jobView(t: Tx, auth: AuthContext, jobId: string) {
    const job = await t.one<JobRow>(`select * from jobs where id = $1 and kind = $2`, [jobId, INGEST_JOB]);
    if (!job) throw notFound('Ingestion job');
    const versionId = String(job.payload.version_id);
    const v = await t.one<{ document_id: string; status: string; error: unknown }>(
      'select document_id, status, error from document_versions where id = $1',
      [versionId],
    );
    if (!v) throw notFound('Ingestion job');
    await getVisibleDocument(t, auth, v.document_id, { includeDeleted: true });
    const stages = await t.many(
      `select stage, attempt, status, processor, processor_version, input_version_id, error_type, error_message,
              started_at, finished_at, duration_ms
         from job_stages where job_id = $1 order by started_at, attempt`,
      [jobId],
    );
    return {
      id: job.id,
      status: job.status,
      document_id: v.document_id,
      version_id: versionId,
      document_status: v.status,
      attempts: job.attempts,
      max_attempts: job.max_attempts,
      next_attempt_at: job.status === 'queued' && job.attempts > 0 ? job.run_at : null,
      last_error: job.last_error,
      result: job.result,
      created_at: job.created_at,
      started_at: job.started_at,
      finished_at: job.finished_at,
      stages,
    };
  }

  route(app, {
    method: 'GET',
    url: '/v1/ingestion-jobs/:id',
    summary: 'Processing status for an ingestion job',
    tags: ['documents'],
    permission: 'document:read',
    scopes: ['documents:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) => tx((t) => jobView(t, auth, params.id)),
  });

  route(app, {
    method: 'GET',
    url: '/v1/documents/:id/jobs',
    summary: 'Processing history for a document',
    tags: ['documents'],
    permission: 'document:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleDocument(t, auth, params.id);
        const jobs = await t.many<{ id: string }>(
          `select j.id from jobs j join document_versions v on v.id::text = j.payload->>'version_id'
            where v.document_id = $1 and j.kind = $2 order by j.created_at desc`,
          [params.id, INGEST_JOB],
        );
        return { items: await Promise.all(jobs.map((j) => jobView(t, auth, j.id))) };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/ingestion-jobs/:id/retry',
    summary: 'Retry a failed or dead-lettered ingestion job',
    tags: ['documents'],
    permission: 'document:upload',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const view = await jobView(t, auth, params.id);
        const job = await retryJob(t, params.id);
        if (!job) throw conflict('Only failed or dead-lettered jobs can be retried.');
        await t.query(`update document_versions set status = 'queued', error = null where id = $1`, [view.version_id]);
        await audit(t, req, {
          action: 'ingestion.retried',
          resourceType: 'document',
          resourceId: view.document_id,
          details: { job_id: params.id },
        });
        return jobView(t, auth, params.id);
      }),
  });
}
