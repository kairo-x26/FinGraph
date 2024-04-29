import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, client, createTestEnv, login, oidcLogin, seedTenant, type TestEnv } from './helpers';

let env: TestEnv;
let token: string;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true, config: { RATE_LIMIT_PER_MINUTE: '1000' } });
  await seedTenant(env.db, 'acme', ACME_USERS);
  const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
  const res = await admin.post('/v1/tenant/provisioning-tokens', { name: 'Okta' });
  expect(res.statusCode).toBe(201);
  token = res.json().token;
});
afterAll(() => env.close());

const scim = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, tok = token) =>
  env.app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/scim+json' },
    payload: payload === undefined ? undefined : JSON.stringify(payload),
  });

describe('SCIM provisioning', () => {
  it('rejects requests without a valid token', async () => {
    const res = await scim('GET', '/scim/v2/Users', undefined, 'fgscim_nope');
    expect(res.statusCode).toBe(401);
  });

  it('creates, finds, updates and deactivates a user', async () => {
    const created = await scim('POST', '/scim/v2/Users', {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      userName: 'new.hire@acme.test',
      name: { givenName: 'New', familyName: 'Hire' },
      roles: [{ value: 'auditor' }],
      externalId: 'okta-123',
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id;
    expect(created.json()).toMatchObject({ userName: 'new.hire@acme.test', displayName: 'New Hire', active: true });

    const dup = await scim('POST', '/scim/v2/Users', { userName: 'new.hire@acme.test' });
    expect(dup.statusCode).toBe(409);

    const found = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "new.hire@acme.test"'));
    expect(found.json().totalResults).toBe(1);

    const patched = await scim('PATCH', `/scim/v2/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', value: { active: false, roles: [{ value: 'analyst' }] } }],
    });
    expect(patched.json()).toMatchObject({ active: false, roles: [{ value: 'analyst' }] });

    const del = await scim('DELETE', `/scim/v2/Users/${id}`);
    expect(del.statusCode).toBe(204);
  });

  it('deprovisioning an existing user ends their sessions', async () => {
    const session = await login(env, 'sam.analyst@acme.test');
    const list = await scim('GET', '/scim/v2/Users?filter=' + encodeURIComponent('userName eq "sam.analyst@acme.test"'));
    const id = list.json().Resources[0].id;
    await scim('PATCH', `/scim/v2/Users/${id}`, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
      Operations: [{ op: 'replace', path: 'active', value: false }],
    });
    expect((await client(env.app, session).get('/v1/auth/session')).statusCode).toBe(401);
  });

  it('stops accepting a revoked token', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const created = await admin.post('/v1/tenant/provisioning-tokens', { name: 'temp' });
    await admin.delete(`/v1/tenant/provisioning-tokens/${created.json().id}`);
    const res = await scim('GET', '/scim/v2/Users', undefined, created.json().token);
    expect(res.statusCode).toBe(401);
  });
});

describe('access policies', () => {
  it('blocks sign-in and sessions from outside the IP allowlist', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const analystSession = await login(env, 'ana.analyst@acme.test');
    const set = await admin.patch('/v1/tenant/settings', { ip_allowlist: ['10.0.0.0/8'] });
    expect(set.statusCode).toBe(200);
    // inject() requests come from 127.0.0.1
    expect((await client(env.app, analystSession).get('/v1/auth/session')).statusCode).toBe(401);
    const { location } = await oidcLogin(env, 'ana.analyst@acme.test');
    expect(location).toContain('network_not_allowed');
    await env.db.system((tx) => tx.query(`update tenants set settings = settings - 'ip_allowlist'`));
    expect((await client(env.app, analystSession).get('/v1/auth/session')).statusCode).toBe(200);
  });
});
