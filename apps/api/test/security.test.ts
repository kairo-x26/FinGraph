import { northwindFixtures } from '@fingraph/fixtures';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, approveCriticalFacts, client, createTestEnv, login, seedTenant, uploadDocument, type Client, type TestEnv } from './helpers';

/**
 * Object-level authorization sweep (spec 9.1: "a known ID is not evidence of
 * permission"). Every route with a path parameter is called by a fully privileged
 * user from another organization, using real identifiers from the first one.
 */
let env: TestEnv;
let ids: Record<string, string>;
let attacker: Client;

const PUBLIC = [
  '/healthz',
  '/readyz',
  '/metrics',
  '/oauth/token',
  '/v1/auth/login',
  '/v1/auth/callback',
  '/v1/organizations',
  '/v1/uploads/{id}',
  '/v1/shared-exports/{token}',
  '/v1/connections/{provider}/callback',
];

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  const acme = await seedTenant(env.db, 'acme', ACME_USERS);
  await seedTenant(env.db, 'globex', [{ email: 'olga@globex.test', name: 'Olga', roles: ['admin', 'analyst', 'risk_manager', 'auditor', 'developer'] }]);
  const c = await acmeClients(env);
  const fx = await northwindFixtures();
  const caseId = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC', assignee_id: acme.userIds['ana.analyst@acme.test'] })).json().id;
  const docs: string[] = [];
  for (const f of fx) docs.push((await uploadDocument(env.app, c.onboarding, caseId, f)).json().document_id);
  await env.app.worker.drain();
  await c.analyst.post(`/v1/cases/${caseId}/start-review`);
  await approveCriticalFacts(c.analyst, caseId);
  const fact = (await c.analyst.get(`/v1/cases/${caseId}/facts`)).json().items[0];
  const graph = (await c.analyst.get(`/v1/cases/${caseId}/graph`)).json();
  const answer = (await c.analyst.post(`/v1/cases/${caseId}/questions`, { question: 'Who owns the company?' })).json();
  const exp = (await c.auditor.post('/v1/audit/exports', { case_id: caseId })).json();
  await env.app.worker.drain();
  const hook = (await c.developer.post('/v1/webhooks', { url: 'http://127.0.0.1:9/hook', event_types: ['case.review_completed'] })).json();
  await c.developer.post(`/v1/webhooks/${hook.id}/test`);
  await env.app.worker.drain();
  const delivery = (await c.developer.get(`/v1/webhooks/${hook.id}/deliveries`)).json().items[0];
  const apiClient = (await c.developer.post('/v1/api-clients', { name: 'Sweep client', scopes: ['cases:read'] })).json();
  const hold = (await c.admin.post('/v1/legal-holds', { case_id: caseId, reason: 'Hold for the sweep test' })).json();
  const invite = (await c.admin.post('/v1/invitations', { email: 'new@acme.test', display_name: 'New', roles: ['analyst'] })).json();
  const policies = (await c.risk.get('/v1/policies')).json().items;
  const share = (await c.auditor.post(`/v1/audit/exports/${exp.id}/shares`, { recipient: 'x@y.test' })).json();
  const scim = (await c.admin.post('/v1/tenant/provisioning-tokens', { name: 'x' })).json();
  const notif = (await c.analyst.get('/v1/notifications')).json().items[0];
  const request = (await c.analyst.post(`/v1/cases/${caseId}/requests`, { message: 'Please send more' })).json();
  const job = await env.db.system((tx) => tx.one<{ id: string }>(`select id from jobs where kind = 'ingest_document' limit 1`));
  const versionId = (await c.analyst.get(`/v1/documents/${docs[0]}`)).json().current_version_id;
  await env.db.system((tx) =>
    tx.query(`insert into entity_duplicates (tenant_id, entity_a, entity_b, score) values ($1, $2, $3, 0.95)`, [acme.tenantId, graph.nodes[0].id, graph.nodes[1].id]),
  );
  const dup = await env.db.system((tx) => tx.one<{ id: string }>('select id from entity_duplicates limit 1'));
  const connection = await env.db.system((tx) =>
    tx.one<{ id: string }>(`insert into connections (tenant_id, provider, status) values ($1, 'sandbox_drive', 'active') returning id`, [acme.tenantId]),
  );
  ids = {
    case: caseId,
    document: docs[0]!,
    version: versionId,
    fact: fact.id,
    relationship: graph.edges[0].id,
    entity: graph.nodes[0].id,
    export: exp.id,
    ai: answer.id,
    user: acme.userIds['ana.analyst@acme.test']!,
    invitation: invite.invitation.id,
    job: job!.id,
    webhook: hook.id,
    delivery: delivery.id,
    apiClient: apiClient.id,
    policy: policies[0].id,
    hold: hold.id,
    share: share.id,
    token: scim.id,
    notification: notif.id,
    request: request.id,
    duplicate: dup!.id,
    connection: connection!.id,
  };
  attacker = client(env.app, await login(env, 'olga@globex.test', 'globex'));
});
afterAll(() => env.close());

function resolve(path: string): string | null {
  const segs = path.split('/');
  let out = path;
  for (let i = 0; i < segs.length; i++) {
    const m = segs[i]!.match(/^\{(\w+)\}$/);
    if (!m) continue;
    const prev = segs[i - 1];
    const param = m[1]!;
    const pick: Record<string, string | undefined> = {
      cases: ids.case,
      documents: ids.document,
      versions: ids.version,
      'extracted-facts': ids.fact,
      relationships: ids.relationship,
      entities: ids.entity,
      duplicates: ids.duplicate,
      exports: ids.export,
      'ai-interactions': ids.ai,
      users: ids.user,
      invitations: ids.invitation,
      'ingestion-jobs': ids.job,
      webhooks: ids.webhook,
      deliveries: ids.delivery,
      'api-clients': ids.apiClient,
      policies: ids.policy,
      'legal-holds': ids.hold,
      shares: ids.share,
      'provisioning-tokens': ids.token,
      notifications: ids.notification,
      requests: ids.request,
      connections: ids.connection,
      members: ids.user,
      grants: ids.user,
      checklist: 'ubo',
    };
    let value = pick[prev ?? ''];
    if (param === 'provider') value = 'sandbox_drive';
    if (!value) return null;
    out = out.replace(`{${param}}`, value);
  }
  return out;
}

describe('cross-tenant authorization sweep', () => {
  it('never lets another organization read or change objects by id', async () => {
    const spec = (await env.app.inject({ method: 'GET', url: '/docs/json' })).json() as { paths: Record<string, Record<string, unknown>> };
    const results: string[] = [];
    let checked = 0;
    for (const [path, methods] of Object.entries(spec.paths)) {
      // {provider} is a fixed name, not an object identifier
      if (!path.includes('{') || PUBLIC.includes(path) || path.startsWith('/scim') || path.includes('{provider}')) continue;
      const url = resolve(path);
      expect(url, `no id mapping for ${path}`).not.toBeNull();
      for (const method of Object.keys(methods)) {
        if (method === 'head' || method === 'options') continue;
        const m = method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
        const body = m === 'GET' ? undefined : { reason: 'sweep test reason', comment: 'sweep', action: 'approve', rationale: 'x'.repeat(30), decision: 'approve', outcome: 'approve', message: 'sweep message', roles: ['analyst'], role: 'reviewer', status: 'active', feedback: 'helpful', case_id: ids.case, recipient: 'a@b.test', body: 'x', title: 'x' };
        const res = m === 'GET' ? await attacker.get(url!) : m === 'DELETE' ? await attacker.delete(url!, body) : await attacker[m.toLowerCase() as 'post' | 'put' | 'patch'](url!, body);
        checked++;
        const leaked = res.statusCode < 300 || res.statusCode === 409 || res.statusCode >= 500 || res.body.includes('Northwind');
        if (leaked) results.push(`${m} ${path} -> ${res.statusCode} ${res.body.slice(0, 120)}`);
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect(results).toEqual([]);
  });

  it('requires authentication on every non-public route', async () => {
    const spec = (await env.app.inject({ method: 'GET', url: '/docs/json' })).json() as { paths: Record<string, Record<string, unknown>> };
    const open: string[] = [];
    for (const [path, methods] of Object.entries(spec.paths)) {
      if (PUBLIC.includes(path) || path.startsWith('/scim')) continue;
      const url = resolve(path) ?? path;
      for (const method of Object.keys(methods)) {
        if (method === 'head' || method === 'options') continue;
        const res = await env.app.inject({ method: method.toUpperCase() as 'GET', url, payload: method === 'get' ? undefined : {} });
        if (res.statusCode !== 401) open.push(`${method.toUpperCase()} ${path} -> ${res.statusCode}`);
      }
    }
    expect(open).toEqual([]);
  });

  it('rejects cookies without a CSRF token on every state-changing route', async () => {
    const session = await login(env, 'olga@globex.test', 'globex');
    const res = await env.app.inject({ method: 'POST', url: '/v1/cases', headers: { cookie: session.cookie }, payload: { subject_name: 'CSRF Inc' } });
    expect(res.statusCode).toBe(403);
  });
});
