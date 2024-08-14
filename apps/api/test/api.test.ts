import { northwindFixtures } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, createTestEnv, seedTenant, uploadDocument, type TestEnv } from './helpers';

let env: TestEnv;
let c: Awaited<ReturnType<typeof acmeClients>>;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  await seedTenant(env.db, 'acme', ACME_USERS);
  await seedTenant(env.db, 'globex', [{ email: 'olga@globex.test', name: 'Olga', roles: ['developer'] }]);
  c = await acmeClients(env);
});
afterAll(() => env.close());

async function token(clientId: string, secret: string, scope?: string) {
  const res = await env.app.inject({
    method: 'POST',
    url: '/oauth/token',
    headers: { authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ grant_type: 'client_credentials', ...(scope ? { scope } : {}) }).toString(),
  });
  return res;
}

const bearer = (t: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...extra });

describe('API clients (client credentials)', () => {
  let creds: { client_id: string; client_secret: string; id: string };
  beforeAll(async () => {
    const res = await c.developer.post('/v1/api-clients', { name: 'Onboarding portal', scopes: ['cases:read', 'cases:write', 'documents:write'] });
    expect(res.statusCode).toBe(201);
    creds = res.json();
  });

  it('issues short-lived tokens and rejects bad credentials or scopes', async () => {
    const ok = await token(creds.client_id, creds.client_secret);
    expect(ok.json()).toMatchObject({ token_type: 'Bearer', expires_in: 900, scope: 'cases:read cases:write documents:write' });
    expect((await token(creds.client_id, 'wrong')).statusCode).toBe(401);
    expect((await token(creds.client_id, creds.client_secret, 'audit:export')).json().error).toBe('invalid_scope');
  });

  it('lets clients call the routes their scopes allow, and nothing else', async () => {
    const t = (await token(creds.client_id, creds.client_secret)).json().access_token;
    const created = await env.app.inject({ method: 'POST', url: '/v1/cases', headers: bearer(t), payload: { subject_name: 'API Created LLC' } });
    expect(created.statusCode).toBe(201);
    const audit = await c.risk.get(`/v1/audit/events?resource_id=${created.json().id}`);
    expect(audit.json().items[0]).toMatchObject({ actor_type: 'api_client', actor_id: creds.client_id });
    expect((await env.app.inject({ method: 'GET', url: '/v1/users', headers: bearer(t) })).statusCode).toBe(403);
    expect((await env.app.inject({ method: 'GET', url: '/v1/auth/session', headers: bearer(t) })).statusCode).toBe(403);
    const readOnly = (await token(creds.client_id, creds.client_secret, 'cases:read')).json().access_token;
    expect((await env.app.inject({ method: 'POST', url: '/v1/cases', headers: bearer(readOnly), payload: { subject_name: 'Nope Inc' } })).statusCode).toBe(403);
  });

  it('uploads documents through the API', async () => {
    const t = (await token(creds.client_id, creds.client_secret)).json().access_token;
    const caseId = (await env.app.inject({ method: 'POST', url: '/v1/cases', headers: bearer(t), payload: { subject_name: 'Northwind Payments LLC' } })).json().id;
    const fx = (await northwindFixtures())[0]!;
    const api = {
      post: (url: string, body?: unknown) => env.app.inject({ method: 'POST', url, headers: bearer(t), payload: body as object }),
    } as unknown as Parameters<typeof uploadDocument>[1];
    const res = await uploadDocument(env.app, api, caseId, fx);
    expect(res.statusCode).toBe(202);
    const doc = await c.analyst.get(`/v1/documents/${res.json().document_id}`);
    expect(doc.json().source).toBe('api');
  });

  it('stops working as soon as the client is revoked', async () => {
    const t = (await token(creds.client_id, creds.client_secret)).json().access_token;
    await c.developer.delete(`/v1/api-clients/${creds.id}`);
    expect((await env.app.inject({ method: 'GET', url: '/v1/cases', headers: bearer(t) })).statusCode).toBe(401);
    expect((await token(creds.client_id, creds.client_secret)).statusCode).toBe(401);
  });

  it('rejects forged tokens', async () => {
    const forged = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl';
    expect((await env.app.inject({ method: 'GET', url: '/v1/cases', headers: bearer(forged) })).statusCode).toBe(401);
  });
});

describe('Idempotency-Key', () => {
  it('replays the original response for retries', async () => {
    const h = { 'idempotency-key': 'create-case-0001' };
    const a = await c.onboarding.post('/v1/cases', { subject_name: 'Idempotent Inc' }, h);
    const b = await c.onboarding.post('/v1/cases', { subject_name: 'Idempotent Inc' }, h);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().id).toBe(a.json().id);
    const list = (await c.onboarding.get('/v1/cases?q=idempotent')).json();
    expect(list.items).toHaveLength(1);
  });

  it('rejects a reused key with a different body', async () => {
    const h = { 'idempotency-key': 'create-case-0002' };
    await c.onboarding.post('/v1/cases', { subject_name: 'First Body LLC' }, h);
    const res = await c.onboarding.post('/v1/cases', { subject_name: 'Second Body LLC' }, h);
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('idempotency_key_reused');
  });

  it('scopes keys to the caller', async () => {
    const h = { 'idempotency-key': 'shared-key-0003' };
    const a = await c.onboarding.post('/v1/cases', { subject_name: 'Scoped A' }, h);
    const b = await c.analyst.post('/v1/cases', { subject_name: 'Scoped A' }, h);
    expect(b.json().id).not.toBe(a.json().id);
  });

  it('validates the key format', async () => {
    const res = await c.onboarding.post('/v1/cases', { subject_name: 'Bad Key' }, { 'idempotency-key': 'x' });
    expect(res.statusCode).toBe(400);
  });
});
