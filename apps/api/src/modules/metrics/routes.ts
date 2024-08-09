import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Tx } from '../../db';
import { route } from '../../lib/http';
import { caseVisibleSql } from '../cases/access';
import { settingsOf, type TenantRow } from '../identity/tenants';

export async function tenantUsage(t: Tx, tenantId: string) {
  const tenant = await t.one<TenantRow>('select * from tenants where id = $1', [tenantId]);
  const q = settingsOf(tenant!).quotas;
  const u = (await t.one<{ storage: number; docs_today: number; tokens_today: number; ocr_today: number; users: number; cases: number }>(
    `select (select coalesce(sum(size_bytes), 0)::bigint from document_versions where purged_at is null) as storage,
            (select count(*)::int from document_versions where created_at > now() - interval '1 day') as docs_today,
            (select coalesce(sum(input_tokens + output_tokens), 0)::int from ai_interactions where created_at > now() - interval '1 day') as tokens_today,
            (select count(*)::int from document_pages p join document_versions v on v.id = p.version_id
              where p.ocr and v.processed_at > now() - interval '1 day') as ocr_today,
            (select count(*)::int from users where status = 'active') as users,
            (select count(*)::int from cases where purged_at is null) as cases`,
  ))!;
  const metric = (used: number, limit: number) => ({ used, limit, pct: Math.round((used / limit) * 1000) / 10 });
  return {
    storage_bytes: metric(Number(u.storage), q.storage_bytes),
    documents_today: metric(u.docs_today, q.documents_per_day),
    ai_tokens_today: metric(u.tokens_today, q.ai_tokens_per_day),
    ocr_pages_today: metric(u.ocr_today, q.ocr_pages_per_day),
    active_users: u.users,
    cases: u.cases,
  };
}

export async function metricsRoutes(app: FastifyInstance) {
  route(app, {
    method: 'GET',
    url: '/v1/dashboard',
    summary: 'Case status, workload, exceptions and throughput for the organization',
    tags: ['dashboard'],
    permission: 'dashboard:read',
    query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }),
    handler: async ({ query, auth, tx }) =>
      tx(async (t) => {
        const visible = caseVisibleSql('c', '$1');
        const p = [auth.userId];
        const byStatus = await t.many(`select status, count(*)::int as n from cases c where ${visible} and c.purged_at is null group by status`, p);
        const byRisk = await t.many(
          `select risk_level, count(*)::int as n from cases c where ${visible} and c.closed_at is null and c.purged_at is null group by risk_level`,
          p,
        );
        const workload = await t.many(
          `select u.id as user_id, u.display_name,
                  count(c.id)::int as open_cases,
                  count(c.id) filter (where c.status = 'in_review')::int as in_review,
                  count(c.id) filter (where (c.due_at is not null and c.due_at < now())
                     or (c.review_started_at is not null and c.review_started_at
                         + make_interval(days => coalesce((p.rules->>'review_sla_days')::int, 10)) < now()))::int as overdue
             from users u
             join cases c on c.assignee_id = u.id and c.closed_at is null and ${visible}
             left join compliance_policies p on p.id = c.policy_id
            group by u.id, u.display_name order by open_cases desc`,
          p,
        );
        const unassigned = await t.one<{ n: number }>(`select count(*)::int as n from cases c where ${visible} and c.closed_at is null and c.assignee_id is null`, p);
        const exceptions = await t.many(
          `select v.id as version_id, d.id as document_id, d.title, d.case_id, c.reference, v.status, v.error, v.created_at
             from document_versions v join documents d on d.id = v.document_id join cases c on c.id = d.case_id
            where v.status in ('failed', 'quarantined', 'rejected') and v.created_at > now() - interval '30 days'
              and d.deleted_at is null and ${visible}
            order by v.created_at desc limit 20`,
          p,
        );
        const attention = await t.many(
          `select c.id, c.reference, c.subject_name, c.status, c.risk_level, c.updated_at from cases c
            where ${visible} and c.status in ('escalated', 'pending_approval') order by c.updated_at limit 20`,
          p,
        );
        const throughput = await t.many(
          `select date_trunc('week', c.closed_at) as week,
                  count(*) filter (where d.to_status = 'approved')::int as approved,
                  count(*) filter (where d.to_status = 'rejected')::int as rejected
             from cases c join lateral (select to_status from review_decisions r where r.case_id = c.id
                                         and r.to_status in ('approved', 'rejected') order by created_at desc limit 1) d on true
            where ${visible} and c.closed_at > now() - make_interval(days => $2)
            group by 1 order by 1`,
          [auth.userId, query.days],
        );
        const reviewTime = await t.one<{ median_hours: number | null; p90_hours: number | null; n: number }>(
          `select percentile_cont(0.5) within group (order by extract(epoch from (c.closed_at - c.review_started_at)) / 3600) as median_hours,
                  percentile_cont(0.9) within group (order by extract(epoch from (c.closed_at - c.review_started_at)) / 3600) as p90_hours,
                  count(*)::int as n
             from cases c where ${visible} and c.closed_at > now() - make_interval(days => $2) and c.review_started_at is not null`,
          [auth.userId, query.days],
        );
        const documents = await t.many(
          `select date_trunc('day', v.created_at) as day, count(*)::int as received,
                  count(*) filter (where v.status = 'processed')::int as processed,
                  count(*) filter (where v.status in ('failed', 'quarantined', 'rejected'))::int as failed
             from document_versions v where v.created_at > now() - interval '14 days' group by 1 order by 1`,
        );
        const automation = await t.one<{ docs: number; with_facts: number }>(
          `select count(distinct v.id)::int as docs, count(distinct f.version_id)::int as with_facts
             from document_versions v left join extracted_facts f on f.version_id = v.id
            where v.status = 'processed' and v.created_at > now() - make_interval(days => $1)`,
          [query.days],
        );
        const ai = await t.one(
          `select count(*)::int as questions,
                  count(*) filter (where status = 'answered')::int as answered,
                  count(*) filter (where status = 'insufficient_evidence')::int as abstained,
                  count(*) filter (where feedback = 'helpful')::int as helpful,
                  count(*) filter (where feedback = 'not_helpful')::int as not_helpful
             from ai_interactions where created_at > now() - make_interval(days => $1)`,
          [query.days],
        );
        const facts = await t.one(
          `select count(*) filter (where status = 'candidate')::int as pending,
                  count(*) filter (where status = 'approved')::int as approved,
                  count(*) filter (where status = 'corrected')::int as corrected,
                  count(*) filter (where status = 'rejected')::int as rejected
             from extracted_facts where created_at > now() - make_interval(days => $1)`,
          [query.days],
        );
        return {
          period_days: query.days,
          cases_by_status: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
          open_by_risk: Object.fromEntries(byRisk.map((r) => [r.risk_level, r.n])),
          unassigned: unassigned!.n,
          workload,
          needs_attention: attention,
          exceptions,
          throughput,
          review_time_hours: reviewTime,
          documents_per_day: documents,
          automation: { processed: automation!.docs, with_extracted_facts: automation!.with_facts },
          facts,
          ai,
        };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/tenant/usage',
    summary: 'Usage against organization quotas',
    tags: ['dashboard'],
    permission: 'dashboard:read',
    handler: async ({ auth, tx }) => tx((t) => tenantUsage(t, auth.tenantId)),
  });

  route(app, {
    method: 'GET',
    url: '/v1/admin/alerts',
    summary: 'Operational alerts: dead-lettered jobs, queue backlog, undelivered events and quota pressure',
    tags: ['admin'],
    permission: 'admin:settings',
    handler: async ({ auth, tx }) =>
      tx(async (t) => {
        const jobs = (await t.one<{ dead: number; failed_24h: number; backlog: number; oldest_queued_s: number | null }>(
          `select count(*) filter (where status = 'dead')::int as dead,
                  count(*) filter (where status = 'failed' and finished_at > now() - interval '1 day')::int as failed_24h,
                  count(*) filter (where status = 'queued' and run_at < now() - interval '5 minutes')::int as backlog,
                  extract(epoch from now() - min(run_at) filter (where status = 'queued' and run_at < now()))::int as oldest_queued_s
             from jobs`,
        ))!;
        const outbox = (await t.one<{ pending: number; oldest_s: number | null }>(
          `select count(*)::int as pending, extract(epoch from now() - min(occurred_at))::int as oldest_s
             from outbox_events where dispatched_at is null`,
        ))!;
        const deadJobs = await t.many(
          `select id, kind, attempts, last_error, finished_at, resource_type, resource_id from jobs
            where status = 'dead' order by finished_at desc limit 20`,
        );
        const usage = await tenantUsage(t, auth.tenantId);
        const alerts: { level: 'critical' | 'warning'; code: string; message: string }[] = [];
        if (jobs.dead) alerts.push({ level: 'critical', code: 'dead_jobs', message: `${jobs.dead} job(s) exhausted their retries.` });
        if (jobs.backlog) alerts.push({ level: 'warning', code: 'queue_backlog', message: `${jobs.backlog} job(s) have waited more than 5 minutes.` });
        if (outbox.pending && (outbox.oldest_s ?? 0) > 300) alerts.push({ level: 'warning', code: 'events_delayed', message: `${outbox.pending} event(s) are waiting for delivery.` });
        for (const [k, v] of Object.entries(usage)) {
          if (typeof v === 'object' && v.pct >= 80) alerts.push({ level: v.pct >= 100 ? 'critical' : 'warning', code: `quota_${k}`, message: `${k.replace(/_/g, ' ')} is at ${v.pct}% of quota.` });
        }
        return { alerts, jobs, outbox, dead_jobs: deadJobs, usage };
      }),
  });
}
