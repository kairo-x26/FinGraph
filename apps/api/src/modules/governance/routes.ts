import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { getVisibleCase } from '../cases/access';
import { documentVisibleSql, getVisibleDocument } from '../documents/access';
import { settingsOf, type TenantRow } from '../identity/tenants';
import { enqueue } from '../jobs/queue';
import { notify, usersWithRole } from '../notifications/service';
import { BUILD_EXPORT_JOB, type ExportScope } from './exports';
import { activeHold, PURGE_DOCUMENT_JOB, RETENTION_SWEEP_JOB, retentionCandidates } from './purge';

interface ExportRow {
  id: string;
  case_id: string;
  version_no: number;
  status: string;
  scope: ExportScope;
  requested_by: string | null;
  storage_key: string | null;
  sha256: string | null;
  size_bytes: number | null;
  manifest: unknown;
  created_at: Date;
  ready_at: Date | null;
}

const exportView = (e: ExportRow & { requested_by_name?: string; approved_by_name?: string }) => ({
  id: e.id,
  case_id: e.case_id,
  version_no: e.version_no,
  status: e.status,
  scope: { ...e.scope, document_ids: undefined, documents: e.scope.document_ids.length },
  sha256: e.sha256,
  size_bytes: e.size_bytes,
  manifest: e.manifest,
  requested_by_name: e.requested_by_name ?? null,
  approved_by_name: e.approved_by_name ?? null,
  created_at: e.created_at,
  ready_at: e.ready_at,
  download_url: e.status === 'ready' ? `/v1/audit/exports/${e.id}/download` : null,
});

export async function governanceRoutes(app: FastifyInstance) {
  const { storage } = app.ctx;

  // ---- audit evidence exports (CASE-06, WF-05)

  route(app, {
    method: 'POST',
    url: '/v1/audit/exports',
    summary: 'Request a versioned audit evidence package for a case',
    tags: ['audit'],
    permission: 'audit:export',
    scopes: ['audit:export'],
    status: 202,
    body: z.object({
      case_id: z.uuid(),
      include_files: z.boolean().default(true),
      include_ai: z.boolean().default(true),
      include_audit_trail: z.boolean().default(true),
    }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, body.case_id);
        const docs = await t.many<{ id: string }>(
          `select d.id from documents d where d.case_id = $1 and d.deleted_at is null and ${documentVisibleSql('d', '$2')}`,
          [c.id, auth.userId],
        );
        const tenant = await t.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]);
        const needsApproval = settingsOf(tenant!).exports_require_approval;
        const last = await t.one<{ n: number }>('select coalesce(max(version_no), 0)::int as n from audit_exports where case_id = $1', [c.id]);
        const scope: ExportScope = {
          include_files: body.include_files,
          include_ai: body.include_ai,
          include_audit_trail: body.include_audit_trail,
          document_ids: docs.map((d) => d.id),
          requested_by_name: auth.displayName,
        };
        const exp = await t.one<ExportRow>(
          `insert into audit_exports (tenant_id, case_id, version_no, status, scope, requested_by) values ($1,$2,$3,$4,$5,$6) returning *`,
          [auth.tenantId, c.id, last!.n + 1, needsApproval ? 'pending_approval' : 'queued', JSON.stringify(scope), auth.userId],
        );
        if (needsApproval) {
          await notify(t, {
            tenantId: auth.tenantId,
            userIds: await usersWithRole(t, ['risk_manager']),
            exclude: auth.userId,
            type: 'export.approval_requested',
            title: `Evidence export for ${c.reference} needs approval`,
            link: `/cases/${c.id}?tab=exports`,
            resource: { type: 'audit_export', id: exp!.id },
          });
        } else {
          await enqueue(t, { tenantId: auth.tenantId, kind: BUILD_EXPORT_JOB, payload: { export_id: exp!.id }, resource: { type: 'audit_export', id: exp!.id }, createdBy: auth.userId });
        }
        await audit(t, req, {
          action: 'audit.export_requested',
          resourceType: 'audit_export',
          resourceId: exp!.id,
          details: { case_id: c.id, version_no: exp!.version_no, documents: docs.length, needs_approval: needsApproval },
        });
        return exportView(exp!);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/audit/exports/:id/approve',
    summary: 'Approve a pending evidence export',
    tags: ['audit'],
    permission: 'case:approve',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const e = await t.one<ExportRow>('select * from audit_exports where id = $1 for update', [params.id]);
        if (!e) throw notFound('Export');
        await getVisibleCase(t, auth, e.case_id);
        if (e.status !== 'pending_approval') throw conflict('This export is not waiting for approval.');
        if (e.requested_by === auth.userId) throw forbidden('Exports must be approved by someone other than the requester.');
        const row = await t.one<ExportRow>(`update audit_exports set status = 'queued', approved_by = $2 where id = $1 returning *`, [e.id, auth.userId]);
        await enqueue(t, { tenantId: auth.tenantId, kind: BUILD_EXPORT_JOB, payload: { export_id: e.id }, resource: { type: 'audit_export', id: e.id }, createdBy: auth.userId });
        await audit(t, req, { action: 'audit.export_approved', resourceType: 'audit_export', resourceId: e.id, details: { case_id: e.case_id } });
        return exportView(row!);
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/exports',
    summary: 'Evidence exports for a case',
    tags: ['audit'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const rows = await t.many<ExportRow>(
          `select e.*, u.display_name as requested_by_name, a.display_name as approved_by_name
             from audit_exports e left join users u on u.id = e.requested_by left join users a on a.id = e.approved_by
            where e.case_id = $1 order by e.version_no desc`,
          [params.id],
        );
        return { items: rows.map(exportView) };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/audit/exports/:id',
    summary: 'Retrieve an authorized audit export',
    tags: ['audit'],
    permission: 'audit:export',
    scopes: ['audit:export'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const e = await t.one<ExportRow>(
          `select e.*, u.display_name as requested_by_name from audit_exports e left join users u on u.id = e.requested_by where e.id = $1`,
          [params.id],
        );
        if (!e) throw notFound('Export');
        await getVisibleCase(t, auth, e.case_id);
        return exportView(e);
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/audit/exports/:id/download',
    summary: 'Download an evidence package (ZIP)',
    tags: ['audit'],
    permission: 'audit:export',
    scopes: ['audit:export'],
    params: uuidParam,
    handler: async ({ params, auth, req, reply, tx }) => {
      const e = await tx(async (t) => {
        const row = await t.one<ExportRow>('select * from audit_exports where id = $1', [params.id]);
        if (!row) throw notFound('Export');
        await getVisibleCase(t, auth, row.case_id);
        if (row.status !== 'ready' || !row.storage_key) throw conflict('The export is not ready.');
        await audit(t, req, { action: 'audit.export_downloaded', resourceType: 'audit_export', resourceId: row.id, details: { case_id: row.case_id } });
        return row;
      });
      const data = await storage.get(e.storage_key!);
      return reply
        .header('content-type', 'application/zip')
        .header('content-disposition', `attachment; filename="evidence-${e.case_id}-v${e.version_no}.zip"`)
        .header('x-export-sha256', e.sha256!)
        .send(data);
    },
  });

  // controlled evidence sharing (GOV-04)
  route(app, {
    method: 'POST',
    url: '/v1/audit/exports/:id/shares',
    summary: 'Create a time-limited download link for an external reviewer',
    tags: ['audit'],
    permission: 'audit:export',
    status: 201,
    params: uuidParam,
    body: z.object({ recipient: z.email(), expires_in_hours: z.number().int().min(1).max(24 * 14).default(72), max_downloads: z.number().int().min(1).max(20).default(3) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const e = await t.one<ExportRow>('select * from audit_exports where id = $1', [params.id]);
        if (!e) throw notFound('Export');
        await getVisibleCase(t, auth, e.case_id);
        if (e.status !== 'ready') throw conflict('Only ready exports can be shared.');
        const token = randomToken(32);
        const share = await t.one(
          `insert into export_shares (tenant_id, export_id, recipient, token_hash, expires_at, max_downloads, created_by)
           values ($1,$2,$3,$4, now() + make_interval(hours => $5), $6, $7) returning id, recipient, expires_at, max_downloads`,
          [auth.tenantId, e.id, body.recipient, sha256Hex(token), body.expires_in_hours, body.max_downloads, auth.userId],
        );
        await audit(t, req, { action: 'audit.export_shared', resourceType: 'audit_export', resourceId: e.id, details: { case_id: e.case_id, recipient: body.recipient, expires_in_hours: body.expires_in_hours } });
        return { ...share, url: `${app.ctx.config.PUBLIC_API_URL}/v1/shared-exports/${token}` };
      }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/audit/exports/:id/shares/:shareId',
    summary: 'Revoke a share link',
    tags: ['audit'],
    permission: 'audit:export',
    params: z.object({ id: z.uuid(), shareId: z.uuid() }),
    handler: async ({ params, req, tx }) =>
      tx(async (t) => {
        const r = await t.query('update export_shares set revoked_at = now() where id = $1 and export_id = $2 and revoked_at is null', [params.shareId, params.id]);
        if (!r.rowCount) throw notFound('Share');
        await audit(t, req, { action: 'audit.export_share_revoked', resourceType: 'audit_export', resourceId: params.id, details: { share_id: params.shareId } });
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/shared-exports/:token',
    summary: 'Download a shared evidence package with a share link',
    tags: ['audit'],
    auth: 'none',
    params: z.object({ token: z.string().min(20).max(100) }),
    rateLimit: { max: 20, windowMs: 60_000 },
    handler: async ({ params, req, reply }) => {
      const hit = await app.ctx.db.system(async (t) => {
        const s = await t.one<{ id: string; tenant_id: string; export_id: string; recipient: string }>(
          `update export_shares set downloads = downloads + 1
            where token_hash = $1 and revoked_at is null and expires_at > now() and downloads < max_downloads
            returning id, tenant_id, export_id, recipient`,
          [sha256Hex(params.token)],
        );
        if (!s) return null;
        const e = await t.one<ExportRow>(`select * from audit_exports where id = $1 and status = 'ready'`, [s.export_id]);
        if (!e) return null;
        return { s, e };
      });
      if (!hit) throw new AppError(404, 'not_found', 'This link is invalid, expired or used up.');
      await app.ctx.db.tenant(hit.s.tenant_id, (t) =>
        audit(t, req, {
          tenantId: hit.s.tenant_id,
          action: 'audit.export_downloaded_via_share',
          resourceType: 'audit_export',
          resourceId: hit.e.id,
          details: { case_id: hit.e.case_id, share_id: hit.s.id, recipient: hit.s.recipient },
        }),
      );
      const data = await storage.get(hit.e.storage_key!);
      return reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="evidence-v${hit.e.version_no}.zip"`).send(data);
    },
  });

  // ---- legal holds (GOV-02)

  route(app, {
    method: 'POST',
    url: '/v1/legal-holds',
    summary: 'Place a legal hold on a case or a single document',
    tags: ['governance'],
    permission: 'admin:retention',
    status: 201,
    body: z.object({ case_id: z.uuid(), document_id: z.uuid().optional(), reason: z.string().trim().min(10).max(2000) }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await t.one<{ id: string }>('select id from cases where id = $1', [body.case_id]);
        if (!c) throw notFound('Case');
        if (body.document_id) {
          const d = await t.one('select id from documents where id = $1 and case_id = $2', [body.document_id, body.case_id]);
          if (!d) throw notFound('Document');
        }
        const h = await t.one(
          `insert into legal_holds (tenant_id, case_id, document_id, reason, created_by) values ($1,$2,$3,$4,$5) returning *`,
          [auth.tenantId, body.case_id, body.document_id ?? null, body.reason, auth.userId],
        );
        await audit(t, req, { action: 'legal_hold.placed', resourceType: 'legal_hold', resourceId: h!.id, details: { case_id: body.case_id, document_id: body.document_id ?? null, reason: body.reason } });
        return h;
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/legal-holds',
    summary: 'Legal holds',
    tags: ['governance'],
    permission: 'admin:retention',
    query: z.object({ active: z.enum(['true', 'false']).default('true') }),
    handler: async ({ query, tx }) => ({
      items: await tx((t) =>
        t.many(
          `select h.*, c.reference as case_reference, d.title as document_title, u.display_name as created_by_name
             from legal_holds h join cases c on c.id = h.case_id left join documents d on d.id = h.document_id
             left join users u on u.id = h.created_by
            ${query.active === 'true' ? 'where h.released_at is null' : ''} order by h.created_at desc`,
        ),
      ),
    }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/legal-holds/:id/release',
    summary: 'Release a legal hold',
    tags: ['governance'],
    permission: 'admin:retention',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().min(10).max(2000) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const h = await t.one(
          `update legal_holds set released_at = now(), released_by = $2, release_reason = $3 where id = $1 and released_at is null returning *`,
          [params.id, auth.userId, body.reason],
        );
        if (!h) throw notFound('Legal hold');
        await audit(t, req, { action: 'legal_hold.released', resourceType: 'legal_hold', resourceId: params.id, details: { case_id: h.case_id, reason: body.reason } });
        return h;
      }),
  });

  // ---- retention

  route(app, {
    method: 'GET',
    url: '/v1/admin/retention',
    summary: 'Cases due for deletion under the retention policy',
    tags: ['governance'],
    permission: 'admin:retention',
    handler: async ({ auth, tx }) => tx((t) => retentionCandidates(t, auth.tenantId)),
  });

  route(app, {
    method: 'POST',
    url: '/v1/admin/retention/run',
    summary: 'Run the retention sweep now',
    tags: ['governance'],
    permission: 'admin:retention',
    status: 202,
    handler: async ({ auth, req, tx }) =>
      tx(async (t) => {
        const job = await enqueue(t, { tenantId: auth.tenantId, kind: RETENTION_SWEEP_JOB, dedupeKey: 'retention-sweep', createdBy: auth.userId });
        await audit(t, req, { action: 'retention.sweep_requested', resourceType: 'tenant', resourceId: auth.tenantId, details: { job_id: job.id } });
        return { job_id: job.id };
      }),
  });

  // Document deletion with legal-hold enforcement and derivative purge.
  route(app, {
    method: 'DELETE',
    url: '/v1/documents/:id',
    summary: 'Delete a document and its derived data (blocked by legal holds)',
    tags: ['documents'],
    permission: 'document:delete',
    params: uuidParam,
    body: z.object({ reason: z.string().trim().min(5).max(500) }),
    handler: async ({ params, body, auth, req, reply, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        const hold = await activeHold(t, d.case_id, d.id);
        if (hold) throw conflict(`This document is under legal hold: ${hold.reason}`, { legal_hold_id: hold.id });
        await t.query('update documents set deleted_at = now() where id = $1', [d.id]);
        const job = await enqueue(t, { tenantId: auth.tenantId, kind: PURGE_DOCUMENT_JOB, payload: { document_id: d.id, reason: body.reason }, resource: { type: 'document', id: d.id }, createdBy: auth.userId });
        await audit(t, req, { action: 'document.deleted', resourceType: 'document', resourceId: d.id, details: { case_id: d.case_id, reason: body.reason, purge_job_id: job.id } });
        reply.code(202);
        return { document_id: d.id, purge_job_id: job.id };
      }),
  });
}
