import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CASE_STATUSES, CASE_TYPES, RISK_LEVELS, type CaseType } from '@fingraph/shared';
import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { assertPermission, decodeCursor, page, paginationQuery, route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { emitEvent } from '../events/outbox';
import { caseVisibleSql, getVisibleCase, isClosed, type CaseRow } from './access';
import { checklistItemSchema, currentTemplate, evaluateChecklist, publishTemplate } from './checklists';
import { notify } from '../notifications/service';
import { activePolicy } from '../workflow/policies';

const CASE_PREFIX: Record<CaseType, string> = {
  kyb_onboarding: 'KYB',
  kyb_refresh: 'KYR',
  kyc_individual: 'KYC',
};

async function nextReference(tx: Tx, tenantId: string, caseType: CaseType) {
  const year = new Date().getUTCFullYear();
  const row = await tx.one<{ n: number }>(
    `insert into case_counters (tenant_id, year, n) values ($1, $2, 1)
     on conflict (tenant_id, year) do update set n = case_counters.n + 1 returning n`,
    [tenantId, year],
  );
  return `${CASE_PREFIX[caseType]}-${String(year).slice(2)}-${String(row!.n).padStart(5, '0')}`;
}

async function assertAssignable(tx: Tx, userId: string) {
  const u = await tx.one<{ roles: string[] }>(`select roles from users where id = $1 and status = 'active'`, [userId]);
  if (!u) throw unprocessable('invalid_assignee', 'The assignee must be an active user in this organization.');
  if (!u.roles.some((r) => r === 'analyst' || r === 'risk_manager')) {
    throw unprocessable('invalid_assignee', 'Cases can only be assigned to analysts or risk managers.');
  }
}

const CASE_SELECT = `
  c.*, a.display_name as assignee_name,
  (select count(*)::int from documents d where d.case_id = c.id and d.deleted_at is null) as document_count`;

export async function caseRoutes(app: FastifyInstance) {
  route(app, {
    method: 'POST',
    url: '/v1/cases',
    summary: 'Create a compliance case',
    tags: ['cases'],
    permission: 'case:create',
    scopes: ['cases:write'],
    status: 201,
    body: z.object({
      case_type: z.enum(CASE_TYPES).default('kyb_onboarding'),
      subject_name: z.string().trim().min(2).max(200),
      customer_ref: z.string().trim().max(100).optional(),
      risk_level: z.enum(RISK_LEVELS).default('medium'),
      assignee_id: z.uuid().optional(),
      restricted: z.boolean().default(false),
      due_at: z.iso.datetime().optional(),
    }),
    handler: async ({ body, auth, req, tx }) => {
      if (body.assignee_id) assertPermission(auth, 'case:assign');
      return tx(async (t) => {
        if (body.assignee_id) await assertAssignable(t, body.assignee_id);
        const template = await currentTemplate(t, auth.tenantId, body.case_type);
        const policy = await activePolicy(t, auth.tenantId, body.case_type);
        const reference = await nextReference(t, auth.tenantId, body.case_type);
        const c = await t.one<CaseRow>(
          `insert into cases (tenant_id, reference, case_type, subject_name, customer_ref, risk_level, restricted,
                              assignee_id, created_by, checklist_template_id, due_at, policy_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *`,
          [
            auth.tenantId,
            reference,
            body.case_type,
            body.subject_name,
            body.customer_ref ?? null,
            body.risk_level,
            body.restricted,
            body.assignee_id ?? null,
            auth.userId,
            template.id,
            body.due_at ?? null,
            policy.id || null,
          ],
        );
        await audit(t, req, {
          action: 'case.created',
          resourceType: 'case',
          resourceId: c!.id,
          details: { reference, case_type: body.case_type, checklist_version: template.version, policy_version: policy.version },
        });
        if (body.assignee_id) {
          await notify(t, {
            tenantId: auth.tenantId,
            userIds: [body.assignee_id],
            exclude: auth.userId,
            type: 'case.assigned',
            title: `${reference} was assigned to you`,
            body: body.subject_name,
            link: `/cases/${c!.id}`,
            resource: { type: 'case', id: c!.id },
          });
        }
        if (body.assignee_id) {
          await emitEvent(t, {
            tenantId: auth.tenantId,
            type: 'case.review_assigned',
            resource: { type: 'case', id: c!.id },
            data: { assignee_id: body.assignee_id, reference },
            correlationId: req.id,
          });
        }
        return c;
      });
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases',
    summary: 'List visible cases',
    tags: ['cases'],
    permission: 'case:read',
    scopes: ['cases:read'],
    query: paginationQuery.extend({
      status: z
        .union([z.enum(CASE_STATUSES), z.array(z.enum(CASE_STATUSES))])
        .optional()
        .transform((v) => (v === undefined ? undefined : Array.isArray(v) ? v : [v])),
      assignee: z.union([z.literal('me'), z.literal('none'), z.uuid()]).optional(),
      risk_level: z.enum(RISK_LEVELS).optional(),
      case_type: z.enum(CASE_TYPES).optional(),
      q: z.string().trim().max(100).optional(),
      open: z.enum(['true', 'false']).optional(),
    }),
    handler: async ({ query, auth, tx }) => {
      const params: unknown[] = [auth.userId];
      const where = [caseVisibleSql('c', '$1')];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replaceAll('?', `$${params.length}`));
      };
      if (query.status) add('c.status = any(?)', query.status);
      if (query.assignee === 'me') add('c.assignee_id = ?', auth.userId);
      else if (query.assignee === 'none') where.push('c.assignee_id is null');
      else if (query.assignee) add('c.assignee_id = ?', query.assignee);
      if (query.risk_level) add('c.risk_level = ?', query.risk_level);
      if (query.case_type) add('c.case_type = ?', query.case_type);
      if (query.open === 'true') where.push('c.closed_at is null');
      if (query.open === 'false') where.push('c.closed_at is not null');
      if (query.q) add(`(lower(c.subject_name) like ? or lower(c.reference) like ? or lower(c.customer_ref) like ?)`, `%${query.q.toLowerCase()}%`);
      const cursor = decodeCursor(query.cursor);
      if (cursor) {
        params.push(cursor.createdAt, cursor.id);
        where.push(`(c.created_at, c.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
      }
      params.push(query.limit + 1);
      const rows = await tx((t) =>
        t.many<CaseRow & { assignee_name: string | null }>(
          `select ${CASE_SELECT} from cases c left join users a on a.id = c.assignee_id
            where ${where.join(' and ')} order by c.created_at desc, c.id desc limit $${params.length}`,
          params,
        ),
      );
      return page(rows, query.limit);
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id',
    summary: 'Retrieve a case',
    tags: ['cases'],
    permission: 'case:read',
    scopes: ['cases:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const c = await t.one(
          `select ${CASE_SELECT}, cb.display_name as created_by_name
             from cases c left join users a on a.id = c.assignee_id left join users cb on cb.id = c.created_by
            where c.id = $1`,
          [params.id],
        );
        const members = await t.many(
          `select m.user_id, m.role, u.display_name from case_members m join users u on u.id = m.user_id
            where m.case_id = $1 order by u.display_name`,
          [params.id],
        );
        return { ...c, members };
      }),
  });

  route(app, {
    method: 'PATCH',
    url: '/v1/cases/:id',
    summary: 'Update case details',
    tags: ['cases'],
    permission: 'case:update',
    scopes: ['cases:write'],
    params: uuidParam,
    body: z
      .object({
        subject_name: z.string().trim().min(2).max(200),
        customer_ref: z.string().trim().max(100).nullable(),
        risk_level: z.enum(RISK_LEVELS),
        due_at: z.iso.datetime().nullable(),
        restricted: z.boolean(),
      })
      .partial(),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const before = await getVisibleCase(t, auth, params.id, { forUpdate: true });
        if (isClosed(before)) throw conflict('Closed cases cannot be edited.');
        if (body.restricted !== undefined) assertPermission(auth, 'case:assign');
        const sets: string[] = [];
        const values: unknown[] = [params.id];
        for (const [k, v] of Object.entries(body)) {
          if (v === undefined) continue;
          values.push(v);
          sets.push(`${k} = $${values.length}`);
        }
        if (!sets.length) return before;
        const updated = await t.one(`update cases set ${sets.join(', ')} where id = $1 returning *`, values);
        const changes = Object.fromEntries(
          Object.entries(body).map(([k, v]) => [k, { from: (before as unknown as Record<string, unknown>)[k], to: v }]),
        );
        await audit(t, req, { action: 'case.updated', resourceType: 'case', resourceId: params.id, details: { changes } });
        return updated;
      }),
  });

  type AuditRequest = Parameters<typeof audit>[1];

  async function setAssignee(t: Tx, auth: AuthContext, req: AuditRequest, caseId: string, assigneeId: string | null) {
    const before = await getVisibleCase(t, auth, caseId, { forUpdate: true });
    if (isClosed(before)) throw conflict('Closed cases cannot be reassigned.');
    if (assigneeId) await assertAssignable(t, assigneeId);
    const c = await t.one<CaseRow>('update cases set assignee_id = $2 where id = $1 returning *', [caseId, assigneeId]);
    await audit(t, req, {
      action: 'case.assigned',
      resourceType: 'case',
      resourceId: caseId,
      details: { from: before.assignee_id, to: assigneeId },
    });
    if (assigneeId) {
      await emitEvent(t, {
        tenantId: auth.tenantId,
        type: 'case.review_assigned',
        resource: { type: 'case', id: caseId },
        data: { assignee_id: assigneeId, previous_assignee_id: before.assignee_id, reference: before.reference },
        correlationId: req.id,
      });
      await notify(t, {
        tenantId: auth.tenantId,
        userIds: [assigneeId],
        exclude: auth.userId,
        type: 'case.assigned',
        title: `${before.reference} was assigned to you`,
        body: before.subject_name,
        link: `/cases/${caseId}`,
        resource: { type: 'case', id: caseId },
      });
    }
    return c;
  }

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/assign',
    summary: 'Assign (or unassign) the case reviewer',
    tags: ['cases'],
    permission: 'case:assign',
    scopes: ['cases:write'],
    params: uuidParam,
    body: z.object({ assignee_id: z.uuid().nullable() }),
    handler: async ({ params, body, auth, req, tx }) => tx((t) => setAssignee(t, auth, req, params.id, body.assignee_id)),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/claim',
    summary: 'Assign an unassigned case to yourself',
    tags: ['cases'],
    permission: 'case:review',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id, { forUpdate: true });
        if (c.assignee_id && c.assignee_id !== auth.userId) throw conflict('This case is already assigned.');
        return setAssignee(t, auth, req, params.id, auth.userId);
      }),
  });

  route(app, {
    method: 'PUT',
    url: '/v1/cases/:id/members/:userId',
    summary: 'Add a case member (grants access to restricted cases)',
    tags: ['cases'],
    permission: 'case:assign',
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    body: z.object({ role: z.enum(['reviewer', 'approver', 'watcher']).default('reviewer') }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const u = await t.one(`select id from users where id = $1 and status = 'active'`, [params.userId]);
        if (!u) throw notFound('User');
        await t.query(
          `insert into case_members (tenant_id, case_id, user_id, role, added_by) values ($1,$2,$3,$4,$5)
           on conflict (case_id, user_id) do update set role = excluded.role`,
          [auth.tenantId, params.id, params.userId, body.role, auth.userId],
        );
        await audit(t, req, {
          action: 'case.member_added',
          resourceType: 'case',
          resourceId: params.id,
          details: { user_id: params.userId, role: body.role },
        });
        return { case_id: params.id, user_id: params.userId, role: body.role };
      }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/cases/:id/members/:userId',
    summary: 'Remove a case member',
    tags: ['cases'],
    permission: 'case:assign',
    params: z.object({ id: z.uuid(), userId: z.uuid() }),
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        await t.query('delete from case_members where case_id = $1 and user_id = $2', [params.id, params.userId]);
        await audit(t, req, {
          action: 'case.member_removed',
          resourceType: 'case',
          resourceId: params.id,
          details: { user_id: params.userId },
        });
      }),
  });

  // ---- checklist

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/checklist',
    summary: 'Required-document checklist status for the case',
    tags: ['cases'],
    permission: 'case:read',
    scopes: ['cases:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id);
        return evaluateChecklist(t, c.id, c.checklist_template_id);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/checklist/:key/waive',
    summary: 'Waive a checklist item with a rationale',
    tags: ['cases'],
    permission: 'case:review',
    params: z.object({ id: z.uuid(), key: z.string().max(64) }),
    body: z.object({ reason: z.string().trim().min(10).max(2000) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id);
        if (isClosed(c)) throw conflict('Closed cases cannot be changed.');
        const checklist = await evaluateChecklist(t, c.id, c.checklist_template_id);
        if (!checklist.items.some((i) => i.key === params.key)) throw notFound('Checklist item');
        await t.query('update checklist_waivers set revoked_at = now() where case_id = $1 and item_key = $2 and revoked_at is null', [
          c.id,
          params.key,
        ]);
        await t.query(
          'insert into checklist_waivers (tenant_id, case_id, item_key, reason, waived_by) values ($1,$2,$3,$4,$5)',
          [auth.tenantId, c.id, params.key, body.reason, auth.userId],
        );
        await audit(t, req, {
          action: 'case.checklist_waived',
          resourceType: 'case',
          resourceId: c.id,
          details: { item: params.key, reason: body.reason },
        });
        return evaluateChecklist(t, c.id, c.checklist_template_id);
      }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/cases/:id/checklist/:key/waive',
    summary: 'Withdraw a checklist waiver',
    tags: ['cases'],
    permission: 'case:review',
    params: z.object({ id: z.uuid(), key: z.string().max(64) }),
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id);
        await t.query('update checklist_waivers set revoked_at = now() where case_id = $1 and item_key = $2 and revoked_at is null', [
          c.id,
          params.key,
        ]);
        await audit(t, req, { action: 'case.checklist_waiver_revoked', resourceType: 'case', resourceId: c.id, details: { item: params.key } });
        return evaluateChecklist(t, c.id, c.checklist_template_id);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/requests',
    summary: 'Request additional documents from the customer',
    tags: ['cases'],
    permission: 'case:update',
    status: 201,
    params: uuidParam,
    body: z.object({ item_key: z.string().max(64).optional(), message: z.string().trim().min(5).max(2000) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id);
        if (isClosed(c)) throw conflict('Closed cases cannot be changed.');
        const r = await t.one(
          `insert into document_requests (tenant_id, case_id, item_key, message, requested_by)
           values ($1,$2,$3,$4,$5) returning *`,
          [auth.tenantId, c.id, body.item_key ?? null, body.message, auth.userId],
        );
        await audit(t, req, { action: 'case.documents_requested', resourceType: 'case', resourceId: c.id, details: body });
        return r;
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/requests',
    summary: 'List document requests for a case',
    tags: ['cases'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return {
          items: await t.many(
            `select r.*, u.display_name as requested_by_name from document_requests r
               left join users u on u.id = r.requested_by where r.case_id = $1 order by r.created_at desc`,
            [params.id],
          ),
        };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/requests/:requestId/resolve',
    summary: 'Mark a document request fulfilled or cancelled',
    tags: ['cases'],
    permission: 'case:update',
    params: z.object({ id: z.uuid(), requestId: z.uuid() }),
    body: z.object({ status: z.enum(['fulfilled', 'cancelled']) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const r = await t.one(
          `update document_requests set status = $3, resolved_at = now()
            where id = $2 and case_id = $1 and status = 'open' returning *`,
          [params.id, params.requestId, body.status],
        );
        if (!r) throw notFound('Request');
        await audit(t, req, { action: `case.request_${body.status}`, resourceType: 'case', resourceId: params.id, details: { request_id: params.requestId } });
        return r;
      }),
  });

  // ---- notes

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/notes',
    summary: 'List case notes',
    tags: ['cases'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return {
          items: await t.many(
            `select n.*, u.display_name as author_name from case_notes n left join users u on u.id = n.author_id
              where n.case_id = $1 order by n.created_at`,
            [params.id],
          ),
        };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/notes',
    summary: 'Add a case note',
    tags: ['cases'],
    permission: 'case:update',
    status: 201,
    params: uuidParam,
    body: z.object({ body: z.string().trim().min(1).max(10_000) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const n = await t.one(
          'insert into case_notes (tenant_id, case_id, author_id, body) values ($1,$2,$3,$4) returning *',
          [auth.tenantId, params.id, auth.userId, body.body],
        );
        await audit(t, req, { action: 'case.note_added', resourceType: 'case', resourceId: params.id, details: { note_id: n!.id } });
        return n;
      }),
  });

  // ---- timeline

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/timeline',
    summary: 'Audit trail for the case and its documents',
    tags: ['cases'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return {
          items: await t.many(
            `select a.id, a.seq, a.occurred_at, a.actor_type, a.actor_id, u.display_name as actor_name,
                    a.action, a.resource_type, a.resource_id, a.details
               from audit_events a left join users u on a.actor_type = 'user' and u.id::text = a.actor_id
              where (a.resource_type = 'case' and a.resource_id = $1)
                 or (a.details->>'case_id' = $1)
              order by a.seq desc limit 500`,
            [params.id],
          ),
        };
      }),
  });

  // ---- checklist templates (CASE-02)

  route(app, {
    method: 'GET',
    url: '/v1/checklist-templates',
    summary: 'Current checklist template per case type, with version history',
    tags: ['cases'],
    permission: 'case:read',
    handler: async ({ auth, tx }) =>
      tx(async (t) => {
        for (const ct of CASE_TYPES) await currentTemplate(t, auth.tenantId, ct);
        const rows = await t.many(
          `select ct.*, u.display_name as created_by_name from checklist_templates ct
             left join users u on u.id = ct.created_by order by case_type, version desc`,
        );
        return { items: rows };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/checklist-templates',
    summary: 'Publish a new checklist template version for a case type',
    tags: ['cases'],
    permission: 'admin:policies',
    status: 201,
    body: z.object({
      case_type: z.enum(CASE_TYPES),
      items: z.array(checklistItemSchema).min(1).max(40),
      notes: z.string().max(1000).optional(),
    }),
    handler: async ({ body, auth, req, tx }) => {
      const keys = new Set(body.items.map((i) => i.key));
      if (keys.size !== body.items.length) throw unprocessable('duplicate_keys', 'Checklist item keys must be unique.');
      return tx(async (t) => {
        const tpl = await publishTemplate(t, auth.tenantId, body.case_type, body.items, auth.userId, body.notes);
        await audit(t, req, {
          action: 'checklist_template.published',
          resourceType: 'checklist_template',
          resourceId: tpl.id,
          details: { case_type: body.case_type, version: tpl.version },
        });
        return tpl;
      });
    },
  });
}
