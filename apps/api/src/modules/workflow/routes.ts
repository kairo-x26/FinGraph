import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CASE_TYPES, type CaseStatus } from '@fingraph/shared';
import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { getVisibleCase, type CaseRow } from '../cases/access';
import { emitEvent } from '../events/outbox';
import { notify, usersWithRole } from '../notifications/service';
import { canTransition, casePolicy, evaluateReadiness, recordDecision, snapshotOf, type DecisionKind } from './engine';
import { activePolicy, policyRulesSchema, type PolicyRow } from './policies';

const rationale = (min: number) => z.string().trim().min(min, `Give a rationale of at least ${min} characters.`).max(5000);

type CaseWithPolicy = CaseRow & { policy_id: string | null };

async function lockCase(t: Tx, auth: AuthContext, id: string) {
  return (await getVisibleCase(t, auth, id, { forUpdate: true })) as CaseWithPolicy;
}

function assertTransition(c: CaseRow, to: CaseStatus) {
  if (!canTransition(c.status, to)) {
    throw conflict(`A case that is ${c.status.replace('_', ' ')} cannot move to ${to.replace('_', ' ')}.`, {
      from: c.status,
      to,
    });
  }
}

async function isReviewer(t: Tx, c: CaseRow, userId: string | null) {
  if (!userId) return false;
  if (c.assignee_id === userId) return true;
  const m = await t.one(`select 1 from case_members where case_id = $1 and user_id = $2 and role = 'reviewer'`, [c.id, userId]);
  return !!m;
}

export async function workflowRoutes(app: FastifyInstance) {
  async function transition(
    t: Tx,
    req: Parameters<typeof audit>[1],
    auth: AuthContext,
    c: CaseWithPolicy,
    kind: DecisionKind,
    to: CaseStatus,
    extra: { outcome?: string; rationale?: string; snapshot?: Record<string, unknown>; policy?: PolicyRow | null } = {},
  ) {
    assertTransition(c, to);
    const policy = extra.policy ?? (await casePolicy(t, c));
    const decision = await recordDecision(t, c, {
      kind,
      to,
      outcome: extra.outcome,
      rationale: extra.rationale,
      userId: auth.userId,
      policy,
      snapshot: extra.snapshot,
    });
    await audit(t, req, {
      action: `case.${kind}`,
      resourceType: 'case',
      resourceId: c.id,
      details: { from: c.status, to, outcome: extra.outcome ?? null, decision_id: decision.id, policy_version: policy.version },
    });
    const link = `/cases/${c.id}`;
    if (to === 'pending_approval' || to === 'escalated') {
      await notify(t, {
        tenantId: auth.tenantId,
        userIds: await usersWithRole(t, ['risk_manager']),
        exclude: auth.userId,
        type: to === 'escalated' ? 'case.escalated' : 'case.approval_requested',
        title: `${c.reference} ${to === 'escalated' ? 'was escalated' : 'needs approval'}`,
        body: `${c.subject_name}: ${extra.rationale?.slice(0, 200) ?? ''}`,
        link,
        resource: { type: 'case', id: c.id },
      });
    }
    if (to === 'approved' || to === 'rejected') {
      await emitEvent(t, {
        tenantId: auth.tenantId,
        type: 'case.review_completed',
        resource: { type: 'case', id: c.id },
        data: { reference: c.reference, outcome: to, decision_id: decision.id, policy_version: policy.version },
        correlationId: req.id,
      });
      await notify(t, {
        tenantId: auth.tenantId,
        userIds: [c.assignee_id, c.created_by],
        exclude: auth.userId,
        type: 'case.completed',
        title: `${c.reference} was ${to}`,
        link,
        resource: { type: 'case', id: c.id },
      });
    }
    if (kind === 'return') {
      await notify(t, { tenantId: auth.tenantId, userIds: [c.assignee_id], exclude: auth.userId, type: 'case.returned', title: `${c.reference} was returned for more review`, body: extra.rationale, link, resource: { type: 'case', id: c.id } });
    }
    return decision;
  }

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/readiness',
    summary: 'Policy checks and findings that determine whether the case can be approved',
    tags: ['workflow'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const c = (await getVisibleCase(t, auth, params.id)) as CaseWithPolicy;
        return evaluateReadiness(t, c, auth.userId);
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/decisions',
    summary: 'Review decisions recorded for the case',
    tags: ['workflow'],
    permission: 'case:read',
    scopes: ['cases:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return {
          items: await t.many(
            `select d.*, u.display_name as decided_by_name, p.name as policy_name
               from review_decisions d left join users u on u.id = d.decided_by
               left join compliance_policies p on p.id = d.policy_id
              where d.case_id = $1 order by d.created_at`,
            [params.id],
          ),
        };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/start-review',
    summary: 'Start (or resume) reviewing a case',
    tags: ['workflow'],
    permission: 'case:review',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        if (c.assignee_id && c.assignee_id !== auth.userId && !(await isReviewer(t, c, auth.userId))) {
          throw conflict('This case is assigned to someone else.');
        }
        if (!c.assignee_id) await t.query('update cases set assignee_id = $2 where id = $1', [c.id, auth.userId]);
        await transition(t, req, auth, c, 'start', 'in_review');
        return getVisibleCase(t, auth, c.id);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/request-info',
    summary: 'Pause the review while waiting for the customer',
    tags: ['workflow'],
    permission: 'case:review',
    params: uuidParam,
    body: z.object({ message: rationale(10), item_key: z.string().max(64).optional() }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        if (!(await isReviewer(t, c, auth.userId))) throw forbidden('Only the case reviewer can request information.');
        await t.query(
          `insert into document_requests (tenant_id, case_id, item_key, message, requested_by) values ($1,$2,$3,$4,$5)`,
          [auth.tenantId, c.id, body.item_key ?? null, body.message, auth.userId],
        );
        await transition(t, req, auth, c, 'info_request', 'info_requested', { outcome: 'request_info', rationale: body.message });
        await notify(t, { tenantId: auth.tenantId, userIds: [c.created_by], exclude: auth.userId, type: 'case.info_requested', title: `${c.reference} needs more documents`, body: body.message, link: `/cases/${c.id}`, resource: { type: 'case', id: c.id } });
        return getVisibleCase(t, auth, c.id);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/recommendation',
    summary: 'Record the reviewer’s recommendation; routes to approval when policy requires',
    tags: ['workflow'],
    permission: 'case:review',
    params: uuidParam,
    body: z.object({ outcome: z.enum(['approve', 'reject']), rationale: rationale(20) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        if (c.status !== 'in_review') assertTransition(c, 'pending_approval');
        if (!(await isReviewer(t, c, auth.userId))) throw forbidden('Only the assigned reviewer can submit a recommendation.');
        const readiness = await evaluateReadiness(t, c, auth.userId);
        if (body.outcome === 'approve' && !readiness.can_approve) {
          throw unprocessable('policy_checks_failed', 'The case does not meet the policy requirements for approval yet.', {
            checks: readiness.checks.filter((x) => !x.ok),
          });
        }
        let to: CaseStatus;
        if (body.outcome === 'approve' && readiness.escalation_required) to = 'escalated';
        else if (readiness.second_approval_required) to = 'pending_approval';
        else to = body.outcome === 'approve' ? 'approved' : 'rejected';
        const decision = await transition(t, req, auth, c, 'recommendation', to, {
          outcome: body.outcome,
          rationale: body.rationale,
          snapshot: snapshotOf(readiness),
        });
        return { case: await getVisibleCase(t, auth, c.id), decision, readiness };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/escalate',
    summary: 'Escalate a case to a risk manager',
    tags: ['workflow'],
    permission: 'case:review',
    params: uuidParam,
    body: z.object({ rationale: rationale(20) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        const readiness = await evaluateReadiness(t, c, auth.userId);
        await transition(t, req, auth, c, 'escalation', 'escalated', { outcome: 'escalate', rationale: body.rationale, snapshot: snapshotOf(readiness) });
        return getVisibleCase(t, auth, c.id);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/approval',
    summary: 'Second-line decision on a pending or escalated case (four-eyes)',
    tags: ['workflow'],
    permission: 'case:approve',
    params: uuidParam,
    body: z.object({ decision: z.enum(['approve', 'reject', 'return']), rationale: rationale(20) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        if (!['pending_approval', 'escalated'].includes(c.status)) {
          throw conflict('Only cases awaiting approval or escalated cases can be decided here.');
        }
        const recommendation = await t.one<{ decided_by: string | null; outcome: string }>(
          `select decided_by, outcome from review_decisions where case_id = $1 and kind in ('recommendation', 'escalation')
            order by created_at desc limit 1`,
          [c.id],
        );
        if (auth.userId && (recommendation?.decided_by === auth.userId || c.assignee_id === auth.userId)) {
          throw forbidden('The approver must be a different person from the reviewer.');
        }
        const readiness = await evaluateReadiness(t, c, auth.userId);
        if (body.decision === 'approve' && !readiness.can_approve) {
          throw unprocessable('policy_checks_failed', 'The case does not meet the policy requirements for approval.', {
            checks: readiness.checks.filter((x) => !x.ok),
          });
        }
        const to: CaseStatus = body.decision === 'approve' ? 'approved' : body.decision === 'reject' ? 'rejected' : 'in_review';
        const decision = await transition(t, req, auth, c, body.decision === 'return' ? 'return' : 'approval', to, {
          outcome: body.decision,
          rationale: body.rationale,
          snapshot: { ...snapshotOf(readiness), recommendation: recommendation ?? null },
        });
        return { case: await getVisibleCase(t, auth, c.id), decision };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/reopen',
    summary: 'Reopen a closed case for further review',
    tags: ['workflow'],
    permission: 'case:approve',
    params: uuidParam,
    body: z.object({ rationale: rationale(20) }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        await transition(t, req, auth, c, 'reopen', 'in_review', { rationale: body.rationale });
        return getVisibleCase(t, auth, c.id);
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/archive',
    summary: 'Archive a closed case',
    tags: ['workflow'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) => {
      if (!auth.permissions.has('case:approve') && !auth.permissions.has('admin:retention')) throw forbidden();
      return tx(async (t) => {
        const c = await lockCase(t, auth, params.id);
        await transition(t, req, auth, c, 'archive', 'archived');
        return getVisibleCase(t, auth, c.id);
      });
    },
  });

  // ---- policies (CASE-08)

  route(app, {
    method: 'GET',
    url: '/v1/policies',
    summary: 'Compliance policies with version history',
    tags: ['workflow'],
    permission: 'case:read',
    handler: async ({ auth, tx }) =>
      tx(async (t) => {
        await activePolicy(t, auth.tenantId, 'kyb_onboarding');
        return {
          items: await t.many(
            `select p.*, u.display_name as created_by_name from compliance_policies p left join users u on u.id = p.created_by
              order by p.key, p.version desc`,
          ),
        };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/policies',
    summary: 'Publish a new policy version (the previous version is retired, existing cases keep theirs)',
    tags: ['workflow'],
    permission: 'admin:policies',
    status: 201,
    body: z.object({
      key: z.string().regex(/^[a-z0-9-]{3,64}$/),
      name: z.string().trim().min(3).max(200),
      jurisdiction: z.string().trim().min(2).max(10).default('US'),
      case_types: z.array(z.enum(CASE_TYPES)).min(1),
      rules: policyRulesSchema,
      notes: z.string().trim().max(2000).optional(),
    }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const last = await t.one<{ version: number }>('select max(version)::int as version from compliance_policies where key = $1', [body.key]);
        await t.query(
          `update compliance_policies set status = 'retired', effective_to = now()
            where status = 'active' and (key = $1 or case_types && $2::text[])`,
          [body.key, body.case_types],
        );
        const p = await t.one<PolicyRow>(
          `insert into compliance_policies (tenant_id, key, name, jurisdiction, version, case_types, rules, notes, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
          [auth.tenantId, body.key, body.name, body.jurisdiction, (last?.version ?? 0) + 1, body.case_types, JSON.stringify(body.rules), body.notes ?? null, auth.userId],
        );
        await audit(t, req, { action: 'policy.published', resourceType: 'policy', resourceId: p!.id, details: { key: body.key, version: p!.version } });
        return p;
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/policies/:id',
    summary: 'A policy version',
    tags: ['workflow'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, tx }) =>
      tx(async (t) => {
        const p = await t.one('select * from compliance_policies where id = $1', [params.id]);
        if (!p) throw notFound('Policy');
        return p;
      }),
  });

}
