import { northwindFixtures, type Fixture } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, approveCriticalFacts, createTestEnv, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let users: Record<string, string>;
let c: Awaited<ReturnType<typeof acmeClients>>;
let fx: Record<string, Fixture>;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  users = (await seedTenant(env.db, 'acme', ACME_USERS)).userIds;
  c = await acmeClients(env);
  fx = Object.fromEntries((await northwindFixtures()).map((f) => [f.key, f]));
});
afterAll(() => env.close());

async function newCase(opts: { risk?: string; keys?: string[]; assignee?: string } = {}) {
  const id = (
    await c.onboarding.post('/v1/cases', {
      subject_name: 'Northwind Payments LLC',
      risk_level: opts.risk ?? 'high',
      assignee_id: opts.assignee ?? users['ana.analyst@acme.test'],
    })
  ).json().id as string;
  for (const k of opts.keys ?? ['formation', 'ubo', 'directors', 'bank', 'tax', 'structure']) {
    await uploadDocument(env.app, c.onboarding, id, fx[k]!);
  }
  await env.app.worker.drain();
  return id;
}

describe('review workflow', () => {
  let caseId: string;
  beforeAll(async () => {
    caseId = await newCase();
  });

  it('rejects transitions the state machine does not allow', async () => {
    const res = await c.analyst.post(`/v1/cases/${caseId}/recommendation`, { outcome: 'approve', rationale: 'Everything checks out on review.' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ from: 'open', to: 'pending_approval' });
  });

  it('starts the review', async () => {
    const res = await c.analyst.post(`/v1/cases/${caseId}/start-review`);
    expect(res.json().status).toBe('in_review');
    expect((await c.analyst2.post(`/v1/cases/${caseId}/start-review`)).statusCode).toBe(409);
  });

  it('blocks approval until critical fields are reviewed', async () => {
    const res = await c.analyst.post(`/v1/cases/${caseId}/recommendation`, { outcome: 'approve', rationale: 'Ready for approval per checklist.' });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('policy_checks_failed');
    expect(res.json().checks[0].key).toBe('critical_facts_reviewed');
  });

  it('escalates when policy findings are open and requires a different approver', async () => {
    expect(await approveCriticalFacts(c.analyst, caseId)).toBeGreaterThan(5);
    const ready = (await c.analyst.get(`/v1/cases/${caseId}/readiness`)).json();
    expect(ready.can_approve).toBe(true);
    expect(ready.escalation_required).toBe(true);
    expect(ready.escalation_findings[0].type).toBe('undeclared_beneficial_owner');
    expect(ready.policy).toMatchObject({ key: 'us-kyb-cdd', version: 1 });

    const rec = await c.analyst.post(`/v1/cases/${caseId}/recommendation`, {
      outcome: 'approve',
      rationale: 'Documents are consistent; indirect owner Thomas Reid to be confirmed by risk.',
    });
    expect(rec.json().case.status).toBe('escalated');

    const notes = (await c.risk.get('/v1/notifications?unread=true')).json();
    expect(notes.items.some((n: { type: string }) => n.type === 'case.escalated')).toBe(true);

    expect((await c.analyst.post(`/v1/cases/${caseId}/approval`, { decision: 'approve', rationale: 'I approve my own case now.' })).statusCode).toBe(403);
    const ok = await c.risk.post(`/v1/cases/${caseId}/approval`, {
      decision: 'approve',
      rationale: 'Thomas Reid verified through Harbor Capital records; risk accepted.',
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().case).toMatchObject({ status: 'approved', closed_at: expect.any(String) });

    const decisions = (await c.auditor.get(`/v1/cases/${caseId}/decisions`)).json().items;
    expect(decisions.map((d: { kind: string; to_status: string }) => `${d.kind}:${d.to_status}`)).toEqual([
      'start:in_review',
      'recommendation:escalated',
      'approval:approved',
    ]);
    expect(decisions[2]).toMatchObject({ policy_version: 1, decided_by_name: 'Rita Chen' });
    expect(decisions[2].snapshot.findings.length).toBeGreaterThan(0);

    const events = await env.db.system((tx) => tx.many(`select type from outbox_events where resource_id = $1 and type = 'case.review_completed'`, [caseId]));
    expect(events).toHaveLength(1);
  });

  it('keeps decisions immutable and closed cases read-only', async () => {
    await expect(env.db.system((tx) => tx.query(`update review_decisions set rationale = 'changed'`))).rejects.toThrow(/immutable/);
    expect((await c.analyst.patch(`/v1/cases/${caseId}`, { risk_level: 'low' })).statusCode).toBe(409);
    const facts = (await c.analyst.get(`/v1/cases/${caseId}/facts`)).json().items;
    expect((await c.analyst.post(`/v1/extracted-facts/${facts[0].id}/reopen`, { comment: 'late change' })).statusCode).toBe(409);
  });

  it('lets an approver reopen and archive', async () => {
    const reopened = await c.risk.post(`/v1/cases/${caseId}/reopen`, { rationale: 'New adverse media requires another look.' });
    expect(reopened.json().status).toBe('in_review');
    expect(reopened.json().closed_at).toBeNull();
  });
});

describe('approval routing', () => {
  it('lets a low-risk case close on the reviewer’s decision', async () => {
    const id = await newCase({ risk: 'low', keys: ['formation'] });
    await c.analyst.post(`/v1/cases/${id}/start-review`);
    const res = await c.analyst.post(`/v1/cases/${id}/recommendation`, { outcome: 'reject', rationale: 'Customer withdrew the application before review.' });
    expect(res.json().case.status).toBe('rejected');
  });

  it('blocks approval on missing evidence', async () => {
    const id = await newCase({ risk: 'low', keys: ['formation'] });
    await c.analyst.post(`/v1/cases/${id}/start-review`);
    await approveCriticalFacts(c.analyst, id);
    const res = await c.analyst.post(`/v1/cases/${id}/recommendation`, { outcome: 'approve', rationale: 'Looks fine, approve please.' });
    expect(res.statusCode).toBe(422);
    expect(res.json().checks.map((x: { key: string }) => x.key)).toContain('blocking_findings');
  });

  it('sends high-risk cases to a second approver who can return them', async () => {
    const id = await newCase({ risk: 'high', keys: ['formation'] });
    await c.analyst.post(`/v1/cases/${id}/start-review`);
    const rec = await c.analyst.post(`/v1/cases/${id}/recommendation`, { outcome: 'reject', rationale: 'Ownership information was never provided.' });
    expect(rec.json().case.status).toBe('pending_approval');
    const ret = await c.risk.post(`/v1/cases/${id}/approval`, { decision: 'return', rationale: 'Request the ownership declaration first.' });
    expect(ret.json().case.status).toBe('in_review');
    const notes = (await c.analyst.get('/v1/notifications')).json();
    expect(notes.items.some((n: { type: string }) => n.type === 'case.returned')).toBe(true);
  });

  it('pauses for customer information', async () => {
    const id = await newCase({ risk: 'medium', keys: [] });
    await c.analyst.post(`/v1/cases/${id}/start-review`);
    const res = await c.analyst.post(`/v1/cases/${id}/request-info`, { message: 'Please send the beneficial ownership declaration.', item_key: 'ubo' });
    expect(res.json().status).toBe('info_requested');
    const checklist = (await c.analyst.get(`/v1/cases/${id}/checklist`)).json();
    expect(checklist.items.find((i: { key: string }) => i.key === 'ubo').status).toBe('requested');
    expect((await c.analyst.post(`/v1/cases/${id}/start-review`)).json().status).toBe('in_review');
  });

  it('prevents reviewers from approving their own recommendation even with approval rights', async () => {
    const id = await newCase({ risk: 'high', keys: ['formation'], assignee: users['rita.risk@acme.test'] });
    await c.risk.post(`/v1/cases/${id}/start-review`);
    await c.risk.post(`/v1/cases/${id}/recommendation`, { outcome: 'reject', rationale: 'Insufficient ownership documentation.' });
    const self = await c.risk.post(`/v1/cases/${id}/approval`, { decision: 'reject', rationale: 'Approving my own recommendation.' });
    expect(self.statusCode).toBe(403);
  });
});

describe('policy versions', () => {
  it('publishes a new version without changing open cases', async () => {
    const before = await newCase({ keys: ['formation'] });
    const res = await c.risk.post('/v1/policies', {
      key: 'us-kyb-cdd',
      name: 'US KYB customer due diligence',
      case_types: ['kyb_onboarding', 'kyb_refresh', 'kyc_individual'],
      rules: { ubo_threshold_pct: 10, second_approval_for: ['medium', 'high'], escalate_on: ['undeclared_beneficial_owner'], block_approval_on: ['missing_evidence'], require_critical_fact_review: true, require_verified_ownership: true, review_sla_days: 5 },
      notes: 'Lower UBO threshold for payments customers',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().version).toBe(2);
    expect((await c.analyst.post('/v1/policies', { key: 'x-y-z', name: 'nope', case_types: ['kyb_onboarding'], rules: {} })).statusCode).toBe(403);

    const after = await newCase({ keys: ['formation'] });
    const r1 = (await c.analyst.get(`/v1/cases/${before}/readiness`)).json();
    const r2 = (await c.analyst.get(`/v1/cases/${after}/readiness`)).json();
    expect(r1.policy.version).toBe(1);
    expect(r2.policy.version).toBe(2);
    expect(r2.checks.map((x: { key: string }) => x.key)).toContain('ownership_verified');
    const list = (await c.analyst.get('/v1/policies')).json().items;
    expect(list.map((p: { version: number; status: string }) => `${p.version}:${p.status}`)).toEqual(['2:active', '1:retired']);
  });
});

describe('notifications', () => {
  it('notifies assignees and marks notifications read', async () => {
    await newCase({ keys: [], assignee: users['sam.analyst@acme.test'] });
    const list = (await c.analyst2.get('/v1/notifications')).json();
    expect(list.items[0]).toMatchObject({ type: 'case.assigned', read_at: null });
    await c.analyst2.post(`/v1/notifications/${list.items[0].id}/read`);
    await c.analyst2.post('/v1/notifications/read-all');
    expect((await c.analyst2.get('/v1/notifications')).json().unread).toBe(0);
    // other users' notifications are not reachable
    expect((await c.analyst.post(`/v1/notifications/${list.items[0].id}/read`)).statusCode).toBe(404);
  });
});
