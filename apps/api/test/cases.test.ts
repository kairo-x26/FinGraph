import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, client, createTestEnv, login, seedTenant, type TestEnv } from './helpers';

let env: TestEnv;
let users: Record<string, string>;
let c: Awaited<ReturnType<typeof acmeClients>>;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  users = (await seedTenant(env.db, 'acme', ACME_USERS)).userIds;
  await seedTenant(env.db, 'globex', [{ email: 'olga@globex.test', name: 'Olga', roles: ['analyst', 'risk_manager'] }]);
  c = await acmeClients(env);
});
afterAll(() => env.close());

const ana = () => users['ana.analyst@acme.test']!;

describe('cases', () => {
  it('lets onboarding create a case with a human readable reference and checklist snapshot', async () => {
    const res = await c.onboarding.post('/v1/cases', {
      case_type: 'kyb_onboarding',
      subject_name: 'Northwind Payments LLC',
      customer_ref: 'CUST-1001',
      assignee_id: ana(),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.reference).toMatch(/^KYB-\d{2}-00001$/);
    expect(body.status).toBe('open');
    expect(body.checklist_template_id).toBeTruthy();

    const checklist = await c.analyst.get(`/v1/cases/${body.id}/checklist`);
    expect(checklist.json().template.version).toBe(1);
    expect(checklist.json().items.map((i: { status: string }) => i.status)).toEqual(Array(6).fill('missing'));
    expect(checklist.json().complete).toBe(false);

    const outbox = await env.db.system((tx) =>
      tx.many(`select type, data from outbox_events where resource_id = $1`, [body.id]),
    );
    expect(outbox).toEqual([{ type: 'case.review_assigned', data: expect.objectContaining({ assignee_id: ana() }) }]);
  });

  it('rejects assignment to users who cannot review', async () => {
    const res = await c.onboarding.post('/v1/cases', {
      subject_name: 'Bad Assignment Inc',
      assignee_id: users['ivy.auditor@acme.test'],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('invalid_assignee');
  });

  it('does not let auditors create or edit cases', async () => {
    expect((await c.auditor.post('/v1/cases', { subject_name: 'Nope LLC' })).statusCode).toBe(403);
  });

  it('filters and paginates the case list', async () => {
    for (let i = 0; i < 4; i++) await c.analyst.post('/v1/cases', { subject_name: `Paginated Holdings ${i}`, risk_level: 'low' });
    const p1 = await c.analyst.get('/v1/cases?limit=2&risk_level=low');
    expect(p1.json().items).toHaveLength(2);
    expect(p1.json().next_cursor).toBeTruthy();
    const p2 = await c.analyst.get(`/v1/cases?limit=2&risk_level=low&cursor=${p1.json().next_cursor}`);
    expect(p2.json().items).toHaveLength(2);
    const ids = [...p1.json().items, ...p2.json().items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(4);
    const search = await c.analyst.get('/v1/cases?q=northwind');
    expect(search.json().items).toHaveLength(1);
    const mine = await c.analyst.get('/v1/cases?assignee=me');
    expect(mine.json().items.map((x: { subject_name: string }) => x.subject_name)).toEqual(['Northwind Payments LLC']);
  });

  it('hides restricted cases from non-members and reveals them to members', async () => {
    const created = await c.risk.post('/v1/cases', { subject_name: 'Sensitive Trust Co', restricted: true });
    const id = created.json().id;
    expect((await c.analyst2.get(`/v1/cases/${id}`)).statusCode).toBe(404);
    expect((await c.analyst2.get('/v1/cases?q=sensitive')).json().items).toHaveLength(0);
    await c.risk.put(`/v1/cases/${id}/members/${users['sam.analyst@acme.test']}`, { role: 'reviewer' });
    expect((await c.analyst2.get(`/v1/cases/${id}`)).statusCode).toBe(200);
  });

  it('supports claiming unassigned cases but not stealing assigned ones', async () => {
    const created = await c.onboarding.post('/v1/cases', { subject_name: 'Claimable Ltd' });
    const id = created.json().id;
    const claim = await c.analyst2.post(`/v1/cases/${id}/claim`);
    expect(claim.json().assignee_id).toBe(users['sam.analyst@acme.test']);
    const steal = await c.analyst.post(`/v1/cases/${id}/claim`);
    expect(steal.statusCode).toBe(409);
  });

  it('waives checklist items with a rationale and records requests', async () => {
    const created = await c.analyst.post('/v1/cases', { subject_name: 'Waiver Works Inc' });
    const id = created.json().id;
    const short = await c.analyst.post(`/v1/cases/${id}/checklist/structure/waive`, { reason: 'n/a' });
    expect(short.statusCode).toBe(422);
    const ok = await c.analyst.post(`/v1/cases/${id}/checklist/tax/waive`, { reason: 'Foreign entity, W-8BEN-E to follow' });
    const tax = ok.json().items.find((i: { key: string }) => i.key === 'tax');
    expect(tax.status).toBe('waived');
    const req = await c.analyst.post(`/v1/cases/${id}/requests`, { item_key: 'bank', message: 'Please send a statement from the last 90 days' });
    expect(req.statusCode).toBe(201);
    const after = await c.analyst.get(`/v1/cases/${id}/checklist`);
    expect(after.json().items.find((i: { key: string }) => i.key === 'bank').status).toBe('requested');
    const timeline = await c.analyst.get(`/v1/cases/${id}/timeline`);
    expect(timeline.json().items.map((e: { action: string }) => e.action)).toEqual([
      'case.documents_requested',
      'case.checklist_waived',
      'case.created',
    ]);
  });

  it('versions checklist templates without changing existing cases', async () => {
    const before = await c.analyst.post('/v1/cases', { subject_name: 'Template Before LLC' });
    const tpl = await c.risk.post('/v1/checklist-templates', {
      case_type: 'kyb_onboarding',
      notes: 'Add policy attestation',
      items: [
        { key: 'formation', label: 'Certificate of incorporation', category: 'certificate_of_incorporation' },
        { key: 'policy', label: 'AML policy', category: 'compliance_policy' },
      ],
    });
    expect(tpl.statusCode).toBe(201);
    expect(tpl.json().version).toBe(2);
    expect((await c.analyst.post('/v1/checklist-templates', { case_type: 'kyb_onboarding', items: [] })).statusCode).toBe(403);

    const after = await c.analyst.post('/v1/cases', { subject_name: 'Template After LLC' });
    const oldList = await c.analyst.get(`/v1/cases/${before.json().id}/checklist`);
    const newList = await c.analyst.get(`/v1/cases/${after.json().id}/checklist`);
    expect(oldList.json().items).toHaveLength(6);
    expect(newList.json().items.map((i: { key: string }) => i.key)).toEqual(['formation', 'policy']);
  });

  it('adds notes and blocks cross-tenant access by id', async () => {
    const created = await c.analyst.post('/v1/cases', { subject_name: 'Notes Corp' });
    const id = created.json().id;
    await c.analyst.post(`/v1/cases/${id}/notes`, { body: 'Called the customer about the missing W-9.' });
    const notes = await c.analyst.get(`/v1/cases/${id}/notes`);
    expect(notes.json().items[0]).toMatchObject({ author_name: 'Ana Ruiz' });

    const olga = client(env.app, await login(env, 'olga@globex.test', 'globex'));
    expect((await olga.get(`/v1/cases/${id}`)).statusCode).toBe(404);
    expect((await olga.post(`/v1/cases/${id}/notes`, { body: 'x' })).statusCode).toBe(404);
    expect((await olga.get('/v1/cases')).json().items).toHaveLength(0);
  });
});
