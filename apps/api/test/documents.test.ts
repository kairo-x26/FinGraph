import { EICAR, northwindFixtures, TINY_PNG, type Fixture } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, client, createTestEnv, login, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let users: Record<string, string>;
let c: Awaited<ReturnType<typeof acmeClients>>;
let fx: Record<string, Fixture>;
let caseId: string;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  users = (await seedTenant(env.db, 'acme', ACME_USERS)).userIds;
  await seedTenant(env.db, 'globex', [{ email: 'olga@globex.test', name: 'Olga', roles: ['analyst'] }]);
  c = await acmeClients(env);
  fx = Object.fromEntries((await northwindFixtures()).map((f) => [f.key, f]));
  caseId = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC' })).json().id;
});
afterAll(() => env.close());

describe('document upload and ingestion', () => {
  it('accepts an upload with 202, processes it asynchronously and exposes status', async () => {
    const res = await uploadDocument(env.app, c.onboarding, caseId, fx.formation!);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body).toMatchObject({ status: 'queued', case_id: caseId, status_url: `/v1/ingestion-jobs/${body.job_id}` });

    const queued = await c.onboarding.get(body.status_url);
    expect(queued.json()).toMatchObject({ status: 'queued', document_status: 'queued' });

    await env.app.worker.drain();
    const done = await c.onboarding.get(body.status_url);
    expect(done.json()).toMatchObject({ status: 'succeeded', document_status: 'processed', attempts: 1 });
    expect(done.json().stages.map((s: { stage: string; status: string }) => `${s.stage}:${s.status}`)).toEqual(
      expect.arrayContaining(['validate:succeeded', 'scan:succeeded']),
    );
    expect(done.json().stages[0]).toMatchObject({ processor: 'fingraph-validator', processor_version: '1.0', input_version_id: body.version_id });

    const events = await env.db.system((tx) =>
      tx.many<{ type: string }>(`select type from outbox_events where resource_id = $1 order by seq`, [body.document_id]),
    );
    expect(events.map((e) => e.type)).toEqual(['document.uploaded', 'document.processing_started', 'document.processed']);
  });

  it('stores files encrypted with a checksum and serves downloads with audit', async () => {
    const res = await uploadDocument(env.app, c.onboarding, caseId, fx.tax!);
    await env.app.worker.drain();
    const id = res.json().document_id;
    const doc = await c.analyst.get(`/v1/documents/${id}`);
    expect(doc.json().sha256).toHaveLength(64);
    const raw = [...(env.app.ctx.storage as unknown as { objects: Map<string, Buffer> }).objects.values()];
    expect(raw.every((b) => b.subarray(0, 4).toString() === 'FGE1')).toBe(true);
    expect(raw.some((b) => b.includes(Buffer.from('84-3920175')))).toBe(false);

    const dl = await c.analyst.get(`/v1/documents/${id}/content`);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toBe('application/pdf');
    expect(Buffer.from(dl.rawPayload).equals(fx.tax!.bytes)).toBe(true);
    expect(dl.headers['content-disposition']).toContain('attachment');

    // onboarding can upload but not download
    expect((await c.onboarding.get(`/v1/documents/${id}/content`)).statusCode).toBe(403);
    const trail = await c.risk.get(`/v1/audit/events?resource_id=${id}&action=document.downloaded`);
    expect(trail.json().items).toHaveLength(1);
  });

  it('links duplicates within the same case instead of storing them twice', async () => {
    const first = await uploadDocument(env.app, c.onboarding, caseId, fx.directors!);
    const second = await uploadDocument(env.app, c.onboarding, caseId, fx.directors!);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ duplicate: true, document_id: first.json().document_id });
  });

  it('flags cross-case duplicates but still accepts them', async () => {
    const other = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind refresh' })).json().id;
    await env.app.worker.drain();
    const res = await uploadDocument(env.app, c.onboarding, other, fx.formation!);
    expect(res.statusCode).toBe(202);
    const doc = await c.analyst.get(`/v1/documents/${res.json().document_id}`);
    expect(doc.json().versions[0].duplicate_of_version_id).toBeTruthy();
  });

  it('quarantines malware and blocks downloads', async () => {
    const res = await uploadDocument(env.app, c.onboarding, caseId, { filename: 'invoice.txt', mime: 'text/plain', bytes: EICAR });
    expect(res.statusCode).toBe(202);
    await env.app.worker.drain();
    const job = await c.onboarding.get(res.json().status_url);
    expect(job.json()).toMatchObject({ status: 'succeeded', document_status: 'quarantined', result: { outcome: 'quarantined' } });
    const dl = await c.analyst.get(`/v1/documents/${res.json().document_id}/content`);
    expect(dl.statusCode).toBe(403);
    expect(dl.json().code).toBe('quarantined');
    const doc = await c.analyst.get(`/v1/documents/${res.json().document_id}`);
    expect(doc.json().scan_result.threats).toContain('Eicar-Test-Signature');
  });

  it('rejects files whose content does not match a supported type', async () => {
    const exe = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(200, 1)]);
    const res = await uploadDocument(env.app, c.onboarding, caseId, { filename: 'report.pdf', mime: 'application/pdf', bytes: exe });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('unsupported_file_type');
    const events = await env.db.system((tx) => tx.many(`select type from outbox_events where type = 'document.validation_failed'`));
    expect(events.length).toBeGreaterThan(0);
  });

  it('rejects declared types that do not match the content', async () => {
    const res = await uploadDocument(env.app, c.onboarding, caseId, { filename: 'scan.pdf', mime: 'application/pdf', bytes: TINY_PNG });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('file_type_mismatch');
    const png = await uploadDocument(env.app, c.onboarding, caseId, { filename: 'scan.png', mime: 'image/png', bytes: TINY_PNG });
    expect(png.statusCode).toBe(202);
  });

  it('refuses unsupported declared types and oversize files up front', async () => {
    const a = await c.onboarding.post('/v1/documents/uploads', { case_id: caseId, filename: 'x.exe', mime_type: 'application/x-msdownload', size_bytes: 10 });
    expect(a.json().code).toBe('unsupported_file_type');
    const b = await c.onboarding.post('/v1/documents/uploads', { case_id: caseId, filename: 'x.pdf', mime_type: 'application/pdf', size_bytes: 10 ** 9 });
    expect(b.json().code).toBe('file_too_large');
  });

  it('rejects tampered and reused upload URLs', async () => {
    const init = await c.onboarding.post('/v1/documents/uploads', { case_id: caseId, filename: 'a.pdf', mime_type: 'application/pdf', size_bytes: fx.bank!.bytes.length });
    const url = new URL(init.json().upload_url);
    const forged = url.pathname + url.search.replace(/sig=[0-9a-f]{4}/, 'sig=0000');
    const bad = await env.app.inject({ method: 'PUT', url: forged, headers: { 'content-type': 'application/octet-stream' }, payload: fx.bank!.bytes });
    expect(bad.statusCode).toBe(403);
    const ok = await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'application/octet-stream' }, payload: fx.bank!.bytes });
    expect(ok.statusCode).toBe(200);
    const again = await env.app.inject({ method: 'PUT', url: url.pathname + url.search, headers: { 'content-type': 'application/octet-stream' }, payload: fx.bank!.bytes });
    expect(again.statusCode).toBe(403);
  });

  it('keeps version history and only promotes a replacement once processed', async () => {
    const v1 = await uploadDocument(env.app, c.onboarding, caseId, fx.ubo!);
    await env.app.worker.drain();
    const docId = v1.json().document_id;
    const altered = { ...fx.ubo!, bytes: Buffer.concat([fx.ubo!.bytes, Buffer.from('\n% revised\n')]) };
    const v2 = await uploadDocument(env.app, c.onboarding, caseId, altered, { replaces_document_id: docId, replaced_reason: 'Customer sent signed copy' });
    expect(v2.statusCode).toBe(202);
    let doc = (await c.analyst.get(`/v1/documents/${docId}`)).json();
    expect(doc.current_version_id).toBe(v1.json().version_id);
    expect(doc.latest_status).toBe('queued');
    await env.app.worker.drain();
    doc = (await c.analyst.get(`/v1/documents/${docId}`)).json();
    expect(doc.current_version_id).toBe(v2.json().version_id);
    expect(doc.versions.map((v: { version_no: number; replaced_reason: string | null }) => [v.version_no, v.replaced_reason])).toEqual([
      [2, 'Customer sent signed copy'],
      [1, null],
    ]);
  });

  it('dead-letters after repeated failures and allows a manual retry', async () => {
    const res = await uploadDocument(env.app, c.onboarding, caseId, fx.structure!);
    const job = res.json().job_id;
    const storage = env.app.ctx.storage;
    const original = storage.get.bind(storage);
    storage.get = async () => {
      throw new Error('storage unavailable');
    };
    try {
      for (let i = 0; i < 5; i++) {
        await env.db.system((tx) => tx.query('update jobs set run_at = now() where id = $1', [job]));
        await env.app.worker.drain();
      }
    } finally {
      storage.get = original;
    }
    const dead = await c.onboarding.get(`/v1/ingestion-jobs/${job}`);
    expect(dead.json()).toMatchObject({ status: 'dead', attempts: 5, document_status: 'failed', last_error: { message: 'storage unavailable' } });
    const failedEvents = await env.db.system((tx) =>
      tx.many(`select 1 from outbox_events where type = 'document.processing_failed' and resource_id = $1`, [res.json().document_id]),
    );
    expect(failedEvents).toHaveLength(1);

    const retry = await c.onboarding.post(`/v1/ingestion-jobs/${job}/retry`);
    expect(retry.json().status).toBe('queued');
    await env.app.worker.drain();
    expect((await c.onboarding.get(`/v1/ingestion-jobs/${job}`)).json().document_status).toBe('processed');
  });

  it('enforces restricted documents and grants', async () => {
    const res = await uploadDocument(env.app, c.analyst, caseId, fx.bank!, { restricted: true, title: 'Bank statement (restricted)' });
    await env.app.worker.drain();
    const id = res.json().document_id;
    expect((await c.analyst.get(`/v1/documents/${id}`)).statusCode).toBe(200);
    expect((await c.analyst2.get(`/v1/documents/${id}`)).statusCode).toBe(404);
    const list = await c.analyst2.get(`/v1/documents?case_id=${caseId}`);
    expect(list.json().items.some((d: { id: string }) => d.id === id)).toBe(false);
    await c.risk.put(`/v1/documents/${id}/grants/${users['sam.analyst@acme.test']}`);
    // risk manager isn't a grantee either
    expect((await c.risk.get(`/v1/documents/${id}`)).statusCode).toBe(404);
  });

  it('never exposes documents across tenants', async () => {
    const docs = await c.analyst.get(`/v1/documents?case_id=${caseId}`);
    const anyId = docs.json().items[0].id;
    const olga = client(env.app, await login(env, 'olga@globex.test', 'globex'));
    expect((await olga.get(`/v1/documents/${anyId}`)).statusCode).toBe(404);
    expect((await olga.get(`/v1/documents?case_id=${caseId}`)).statusCode).toBe(404);
    expect((await olga.get(`/v1/documents/${anyId}/content`)).statusCode).toBe(404);
  });
});
