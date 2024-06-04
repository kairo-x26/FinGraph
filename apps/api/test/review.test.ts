import { northwindFixtures, type Fixture } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, createTestEnv, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let c: Awaited<ReturnType<typeof acmeClients>>;
let fx: Record<string, Fixture>;
let caseId: string;
const docs: Record<string, string> = {};

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  await seedTenant(env.db, 'acme', ACME_USERS);
  c = await acmeClients(env);
  fx = Object.fromEntries((await northwindFixtures()).map((f) => [f.key, f]));
  caseId = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC' })).json().id;
  for (const key of ['formation', 'ubo', 'directors', 'bank', 'tax', 'structure']) {
    const res = await uploadDocument(env.app, c.onboarding, caseId, fx[key]!);
    docs[key] = res.json().document_id;
  }
  await env.app.worker.drain();
});
afterAll(() => env.close());

describe('processing results', () => {
  it('classifies documents and records each stage', async () => {
    const list = await c.analyst.get(`/v1/documents?case_id=${caseId}`);
    const cats = Object.fromEntries(list.json().items.map((d: { id: string; category: string }) => [d.id, d.category]));
    expect(cats[docs.formation!]).toBe('certificate_of_incorporation');
    expect(cats[docs.bank!]).toBe('bank_statement');
    const jobs = await c.analyst.get(`/v1/documents/${docs.ubo}/jobs`);
    expect(jobs.json().items[0].stages.map((s: { stage: string }) => s.stage)).toEqual(['validate', 'scan', 'parse', 'classify', 'extract']);
  });

  it('satisfies the checklist once required documents are processed', async () => {
    const res = await c.analyst.get(`/v1/cases/${caseId}/checklist`);
    expect(res.json().items.map((i: { key: string; status: string }) => `${i.key}:${i.status}`)).toEqual([
      'formation:satisfied',
      'ubo:satisfied',
      'directors:satisfied',
      'bank:satisfied',
      'tax:satisfied',
      'structure:satisfied',
    ]);
    expect(res.json().complete).toBe(true);
  });

  it('exposes proposed fields with source references', async () => {
    const res = await c.analyst.get(`/v1/documents/${docs.formation}/extractions`);
    const body = res.json();
    expect(body.run).toMatchObject({ category: 'certificate_of_incorporation', extractor: 'schema-1.2' });
    const name = body.facts.find((f: { field_key: string }) => f.field_key === 'entity_name');
    expect(name).toMatchObject({ value: 'Northwind Payments LLC', status: 'candidate', critical: true, evidence_page: 1 });
    const pages = await c.analyst.get(`/v1/documents/${docs.formation}/pages`);
    const text = pages.json().pages[0].text as string;
    expect(text.slice(name.evidence_start, name.evidence_end)).toBe('Northwind Payments LLC');
  });

  it('stores the evidence date used for freshness checks', async () => {
    const doc = await c.analyst.get(`/v1/documents/${docs.bank}`);
    expect(doc.json().evidence_date).toBeTruthy();
  });
});

describe('fact review', () => {
  const factOf = async (docKey: string, field: string) => {
    const res = await c.analyst.get(`/v1/documents/${docs[docKey]}/extractions`);
    return res.json().facts.find((f: { field_key: string }) => f.field_key === field);
  };

  it('approves a fact and records the reviewer', async () => {
    const f = await factOf('formation', 'entity_name');
    const res = await c.analyst.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'approved', reviewed_by: expect.any(String) });
    const again = await c.analyst.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' });
    expect(again.statusCode).toBe(409);
  });

  it('corrects a value while preserving the original', async () => {
    const f = await factOf('formation', 'registered_agent');
    const noComment = await c.analyst.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'correct', value: 'CT Corporation' });
    expect(noComment.statusCode).toBe(422);
    const res = await c.analyst.post(`/v1/extracted-facts/${f.id}/reviews`, {
      action: 'correct',
      value: 'Corporate Agents of Delaware, Inc.',
      comment: 'Punctuation per state record',
    });
    expect(res.json()).toMatchObject({ status: 'corrected', value: 'Corporate Agents of Delaware, Inc.' });
    const detail = await c.analyst.get(`/v1/extracted-facts/${f.id}`);
    expect(detail.json().history[0]).toMatchObject({
      action: 'correct',
      previous_value: 'Corporate Agents of Delaware Inc.',
      new_value: 'Corporate Agents of Delaware, Inc.',
      reviewer_name: 'Ana Ruiz',
    });
    expect(detail.json().context.match).toBe('Corporate Agents of Delaware Inc.');
  });

  it('validates corrected values by type', async () => {
    const f = await factOf('formation', 'formation_date');
    const res = await c.analyst.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'correct', value: 'sometime in 2019', comment: 'bad' });
    expect(res.json().code).toBe('invalid_value');
  });

  it('rejects with a reason and can reopen', async () => {
    const f = await factOf('formation', 'entity_type');
    const rej = await c.analyst.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'reject', comment: 'Not relevant for this review' });
    expect(rej.json().status).toBe('rejected');
    const reopen = await c.analyst.post(`/v1/extracted-facts/${f.id}/reopen`, { comment: 'Needed after all' });
    expect(reopen.json().status).toBe('candidate');
  });

  it('keeps reviewers read-only for auditors and onboarding', async () => {
    const f = await factOf('tax', 'ein');
    expect((await c.auditor.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' })).statusCode).toBe(403);
    expect((await c.onboarding.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' })).statusCode).toBe(403);
  });

  it('reprocessing supersedes candidates but keeps reviewed facts', async () => {
    const approved = await factOf('formation', 'entity_name');
    const candidateBefore = await factOf('formation', 'jurisdiction');
    const re = await c.analyst.post(`/v1/documents/${docs.formation}/reprocess`);
    expect(re.statusCode).toBe(202);
    await env.app.worker.drain();
    const after = (await c.analyst.get(`/v1/documents/${docs.formation}/extractions?include_superseded=true`)).json().facts;
    const byId = (id: string) => after.find((f: { id: string }) => f.id === id);
    expect(byId(approved.id).status).toBe('approved');
    expect(byId(candidateBefore.id).status).toBe('superseded');
    const names = after.filter((f: { field_key: string; status: string }) => f.field_key === 'entity_name' && f.status !== 'superseded');
    expect(names).toHaveLength(1);
    const runs = await env.db.system((tx) => tx.many('select id from extraction_runs where version_id = (select current_version_id from documents where id = $1)', [docs.formation]));
    expect(runs).toHaveLength(2);
  });

  it('lists case facts with status counts', async () => {
    const res = await c.analyst.get(`/v1/cases/${caseId}/facts`);
    expect(res.json().counts.approved).toBeGreaterThanOrEqual(1);
    expect(res.json().counts.candidate).toBeGreaterThan(10);
    const critical = await c.analyst.get(`/v1/cases/${caseId}/facts?critical=true&status=candidate`);
    expect(critical.json().items.every((f: { critical: boolean; status: string }) => f.critical && f.status === 'candidate')).toBe(true);
  });

  it('queues reprocessing for outdated extractions', async () => {
    await env.db.system((tx) => tx.query(`update extraction_runs set extractor = 'schema-0.9'`));
    const res = await c.admin.post('/v1/admin/reprocess-outdated');
    expect(res.statusCode).toBe(202);
    await env.app.worker.runOnce();
    const job = await env.db.system((tx) => tx.one('select result from jobs where id = $1', [res.json().job_id]));
    expect(job!.result.queued).toBe(6);
  });
});
