import { northwindFixtures, type Fixture } from '@fingraph/fixtures';
import { strFromU8, unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, approveCriticalFacts, createTestEnv, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let users: Record<string, string>;
let c: Awaited<ReturnType<typeof acmeClients>>;
let fx: Record<string, Fixture>;
let caseId: string;
const docs: Record<string, string> = {};

const objects = () => (env.app.ctx.storage as unknown as { objects: Map<string, Buffer> }).objects;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  users = (await seedTenant(env.db, 'acme', ACME_USERS)).userIds;
  c = await acmeClients(env);
  fx = Object.fromEntries((await northwindFixtures()).map((f) => [f.key, f]));
  caseId = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC', risk_level: 'low', assignee_id: users['ana.analyst@acme.test'] })).json().id;
  for (const k of ['formation', 'ubo', 'directors', 'bank', 'tax']) docs[k] = (await uploadDocument(env.app, c.onboarding, caseId, fx[k]!)).json().document_id;
  docs.structure = (await uploadDocument(env.app, c.analyst, caseId, fx.structure!, { restricted: true })).json().document_id;
  await env.app.worker.drain();
  await c.analyst.post(`/v1/cases/${caseId}/start-review`);
  await approveCriticalFacts(c.analyst, caseId);
  await c.analyst.post(`/v1/cases/${caseId}/questions`, { question: 'Who are the beneficial owners of the company?' });
});
afterAll(() => env.close());

async function buildExport(client = c.auditor) {
  const req = await client.post('/v1/audit/exports', { case_id: caseId });
  expect(req.statusCode).toBe(202);
  await env.app.worker.drain();
  return (await client.get(`/v1/audit/exports/${req.json().id}`)).json();
}

describe('audit evidence export', () => {
  it('builds a reconstructible package with a verified manifest', async () => {
    const exp = await buildExport();
    expect(exp).toMatchObject({ status: 'ready', version_no: 1 });
    const dl = await c.auditor.get(exp.download_url);
    expect(dl.statusCode).toBe(200);
    const zip = Buffer.from(dl.rawPayload);
    expect(createHash('sha256').update(zip).digest('hex')).toBe(exp.sha256);
    const files = unzipSync(new Uint8Array(zip));
    const manifest = JSON.parse(strFromU8(files['manifest.json']!));
    expect(manifest.format).toBe('fingraph-evidence-package/1');
    for (const [path, meta] of Object.entries(manifest.files as Record<string, { sha256: string }>)) {
      expect(createHash('sha256').update(files[path]!).digest('hex')).toBe(meta.sha256);
    }
    const facts = JSON.parse(strFromU8(files['facts.json']!));
    expect(facts.length).toBeGreaterThan(5);
    expect(facts.every((f: { status: string }) => f.status !== 'candidate')).toBe(true);
    const trail = JSON.parse(strFromU8(files['audit_trail.json']!));
    expect(trail.chain_verification.valid).toBe(true);
    expect(trail.events.length).toBeGreaterThan(5);
    const decisions = JSON.parse(strFromU8(files['decisions.json']!));
    expect(decisions[0]).toMatchObject({ kind: 'start', policy_version: 1 });
    expect(Object.keys(files).filter((p) => p.startsWith('files/'))).toHaveLength(5);
    // answers are included only when every cited source is part of the package
    const exportedVersions = new Set(JSON.parse(strFromU8(files['documents.json']!)).flatMap((d: { versions: { version_id: string }[] }) => d.versions.map((v) => v.version_id)));
    for (const i of JSON.parse(strFromU8(files['ai_interactions.json']!))) {
      expect(i.source_versions.every((v: string) => exportedVersions.has(v))).toBe(true);
    }
  });

  it('only contains documents the requester could see', async () => {
    const exp = await buildExport();
    const zip = unzipSync(new Uint8Array(Buffer.from((await c.auditor.get(exp.download_url)).rawPayload)));
    const documents = JSON.parse(strFromU8(zip['documents.json']!));
    expect(documents.map((d: { id: string }) => d.id)).not.toContain(docs.structure);
    expect(exp.version_no).toBe(2);
    const trail = await c.risk.get(`/v1/audit/events?resource_id=${exp.id}`);
    expect(trail.json().items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['audit.export_requested', 'audit.export_built', 'audit.export_downloaded']),
    );
  });

  it('is restricted to roles with export permission', async () => {
    expect((await c.analyst.post('/v1/audit/exports', { case_id: caseId })).statusCode).toBe(403);
  });

  it('requires a second person when exports need approval', async () => {
    await c.admin.patch('/v1/tenant/settings', { exports_require_approval: true });
    const req = await c.auditor.post('/v1/audit/exports', { case_id: caseId });
    expect(req.json().status).toBe('pending_approval');
    await env.app.worker.drain();
    expect((await c.auditor.get(`/v1/audit/exports/${req.json().id}`)).json().status).toBe('pending_approval');
    const ok = await c.risk.post(`/v1/audit/exports/${req.json().id}/approve`);
    expect(ok.json().status).toBe('queued');
    await env.app.worker.drain();
    expect((await c.auditor.get(`/v1/audit/exports/${req.json().id}`)).json().status).toBe('ready');
    await c.admin.patch('/v1/tenant/settings', { exports_require_approval: false });
  });

  it('shares a package through a limited, revocable link', async () => {
    const exp = await buildExport();
    const share = await c.auditor.post(`/v1/audit/exports/${exp.id}/shares`, { recipient: 'external.auditor@kpmg.test', max_downloads: 2 });
    expect(share.statusCode).toBe(201);
    const path = new URL(share.json().url).pathname;
    expect((await env.app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: path })).statusCode).toBe(200);
    expect((await env.app.inject({ method: 'GET', url: path })).statusCode).toBe(404);
    const second = await c.auditor.post(`/v1/audit/exports/${exp.id}/shares`, { recipient: 'x@y.test' });
    await c.auditor.delete(`/v1/audit/exports/${exp.id}/shares/${second.json().id}`);
    expect((await env.app.inject({ method: 'GET', url: new URL(second.json().url).pathname })).statusCode).toBe(404);
  });
});

describe('legal holds and deletion', () => {
  it('blocks deletion under legal hold and purges every derivative afterwards', async () => {
    const hold = await c.admin.post('/v1/legal-holds', { case_id: caseId, reason: 'Subpoena 2024-118 from state regulator' });
    expect(hold.statusCode).toBe(201);
    const blocked = await c.admin.delete(`/v1/documents/${docs.ubo}`, { reason: 'Customer asked us to delete' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().legal_hold_id).toBe(hold.json().id);
    expect((await c.analyst.delete(`/v1/documents/${docs.ubo}`, { reason: 'nope nope' })).statusCode).toBe(403);
    await c.admin.post(`/v1/legal-holds/${hold.json().id}/release`, { reason: 'Matter closed by counsel' });

    const versionKeys = await env.db.system((tx) => tx.many<{ storage_key: string }>('select storage_key from document_versions where document_id = $1', [docs.ubo]));
    const del = await c.admin.delete(`/v1/documents/${docs.ubo}`, { reason: 'Customer asked us to delete' });
    expect(del.statusCode).toBe(202);
    // removed from search and the graph immediately
    expect((await c.analyst.get(`/v1/cases/${caseId}/search?q=Maria`)).json().items.some((h: { document_id: string }) => h.document_id === docs.ubo)).toBe(false);
    await env.app.worker.drain();

    const counts = await env.db.system((tx) =>
      tx.one(
        `select (select count(*)::int from document_chunks where document_id = $1) as chunks,
                (select count(*)::int from extracted_facts where document_id = $1) as facts,
                (select count(*)::int from entity_relationships where evidence_document_id = $1) as rels,
                (select count(*)::int from entity_mentions where document_id = $1) as mentions,
                (select count(*)::int from document_pages p join document_versions v on v.id = p.version_id where v.document_id = $1) as pages`,
        [docs.ubo],
      ),
    );
    expect(counts).toEqual({ chunks: 0, facts: 0, rels: 0, mentions: 0, pages: 0 });
    for (const k of versionKeys) expect(objects().has(k.storage_key)).toBe(false);
    const qa = (await c.analyst.get(`/v1/cases/${caseId}/questions`)).json().items;
    expect(qa).toHaveLength(0);
    const ai = await env.db.system((tx) => tx.one(`select answer, flags from ai_interactions where case_id = $1`, [caseId]));
    expect(ai!.answer).toContain('redacted');
    const trail = (await c.risk.get(`/v1/audit/events?resource_id=${docs.ubo}`)).json().items.map((e: { action: string }) => e.action);
    expect(trail).toEqual(expect.arrayContaining(['document.deleted', 'document.purged']));
  });
});

describe('retention', () => {
  it('purges closed cases after the retention period unless held', async () => {
    const keep = (await c.onboarding.post('/v1/cases', { subject_name: 'Held Holdings Inc' })).json().id;
    const drop = (await c.onboarding.post('/v1/cases', { subject_name: 'Expired Exports LLC' })).json().id;
    const dropDoc = (await uploadDocument(env.app, c.onboarding, drop, fx.formation!)).json().document_id;
    await uploadDocument(env.app, c.onboarding, keep, fx.tax!);
    await env.app.worker.drain();
    await c.admin.patch('/v1/tenant/settings', { default_retention_days: 30 });
    await env.db.system((tx) =>
      tx.query(`update cases set status = 'rejected', closed_at = now() - interval '45 days' where id = any($1)`, [[keep, drop]]),
    );
    await c.admin.post('/v1/legal-holds', { case_id: keep, reason: 'Litigation hold requested by legal' });

    const preview = (await c.admin.get('/v1/admin/retention')).json();
    expect(preview.eligible.map((x: { id: string }) => x.id)).toEqual([drop]);
    expect(preview.held.map((x: { id: string }) => x.id)).toEqual([keep]);

    const run = await c.admin.post('/v1/admin/retention/run');
    expect(run.statusCode).toBe(202);
    await env.app.worker.drain();

    const purged = await env.db.system((tx) => tx.one('select subject_name, status, purged_at from cases where id = $1', [drop]));
    expect(purged).toMatchObject({ subject_name: '[purged]', status: 'archived', purged_at: expect.any(Date) });
    const doc = await env.db.system((tx) => tx.one('select title, purged_at from documents where id = $1', [dropDoc]));
    expect(doc!.title).toBe('[purged document]');
    const orphan = await env.db.system((tx) => tx.one(`select count(*)::int as n from entities where display_name = 'Expired Exports LLC'`));
    expect(orphan!.n).toBe(0);
    const decisions = await env.db.system((tx) => tx.one('select count(*)::int as n from review_decisions where case_id = $1', [drop]));
    expect(decisions!.n).toBe(0);
    const held = await env.db.system((tx) => tx.one('select purged_at from cases where id = $1', [keep]));
    expect(held!.purged_at).toBeNull();
    const verify = (await c.risk.get('/v1/audit/verify')).json();
    expect(verify.valid).toBe(true);
  });
});
