import { northwindFixtures, EICAR } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScheduler } from '../src/jobs';
import { ACME_USERS, acmeClients, createTestEnv, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let users: Record<string, string>;
let c: Awaited<ReturnType<typeof acmeClients>>;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  users = (await seedTenant(env.db, 'acme', ACME_USERS)).userIds;
  c = await acmeClients(env);
  const fx = await northwindFixtures();
  const a = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC', risk_level: 'high', assignee_id: users['ana.analyst@acme.test'] })).json().id;
  await c.onboarding.post('/v1/cases', { subject_name: 'Unassigned Co', risk_level: 'low' });
  await uploadDocument(env.app, c.onboarding, a, fx[0]!);
  await uploadDocument(env.app, c.onboarding, a, { filename: 'bad.txt', mime: 'text/plain', bytes: EICAR });
  await env.app.worker.drain();
  await c.analyst.post(`/v1/cases/${a}/start-review`);
  await env.db.system((tx) => tx.query(`update cases set review_started_at = now() - interval '20 days' where id = $1`, [a]));
});
afterAll(() => env.close());

describe('dashboard', () => {
  it('summarizes status, workload and exceptions', async () => {
    const d = (await c.risk.get('/v1/dashboard')).json();
    expect(d.cases_by_status).toMatchObject({ in_review: 1, open: 1 });
    expect(d.open_by_risk).toMatchObject({ high: 1, low: 1 });
    expect(d.unassigned).toBe(1);
    expect(d.workload[0]).toMatchObject({ display_name: 'Ana Ruiz', open_cases: 1, overdue: 1 });
    expect(d.exceptions[0]).toMatchObject({ status: 'quarantined' });
    expect(d.documents_per_day[0].received).toBe(2);
    expect(d.automation).toEqual({ processed: 1, with_extracted_facts: 1 });
  });

  it('is not available to roles without dashboard access', async () => {
    expect((await c.onboarding.get('/v1/dashboard')).statusCode).toBe(403);
  });

  it('reports usage against quotas and raises alerts', async () => {
    const u = (await c.admin.get('/v1/tenant/usage')).json();
    expect(u.documents_today).toMatchObject({ used: 2, limit: 10000 });
    expect(u.storage_bytes.used).toBeGreaterThan(0);
    await c.admin.patch('/v1/tenant/settings', { quotas: { documents_per_day: 2, storage_bytes: 10 ** 10, ai_tokens_per_day: 1000, ocr_pages_per_day: 10 } });
    const a = (await c.admin.get('/v1/admin/alerts')).json();
    expect(a.alerts.map((x: { code: string }) => x.code)).toContain('quota_documents_today');
    const blocked = await uploadDocument(env.app, c.onboarding, (await c.onboarding.get('/v1/cases')).json().items[0].id, { filename: 'n.txt', mime: 'text/plain', bytes: Buffer.from('hello world') });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().code).toBe('quota_exceeded');
  });
});

describe('scheduler', () => {
  it('enqueues maintenance once per interval per tenant', async () => {
    const s = createScheduler(env.app.ctx);
    const first = await s.tick();
    expect(first).toBe(2);
    expect(await s.tick()).toBe(0);
    const later = new Date(Date.now() + 2 * 86_400_000);
    expect(await s.tick(later)).toBe(1);
    const jobs = await env.db.system((tx) => tx.many<{ kind: string }>(`select kind from jobs where dedupe_key like 'scheduled:%'`));
    expect(jobs.map((j) => j.kind).sort()).toEqual(['reprocess_outdated', 'retention_sweep']);
  });
});
