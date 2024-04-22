import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, client, createTestEnv, login, oidcLogin, seedTenant, type TestEnv } from './helpers';

let env: TestEnv;
let acme: Awaited<ReturnType<typeof seedTenant>>;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true, config: { PLATFORM_ADMIN_TOKEN: 'platform-token-0123456789abcdef' } });
  acme = await seedTenant(env.db, 'acme', ACME_USERS, { require_mfa: true });
  await seedTenant(env.db, 'globex', [{ email: 'olga@globex.test', name: 'Olga', roles: ['admin'] }]);
});
afterAll(() => env.close());

describe('OIDC sign-in', () => {
  it('signs in with PKCE and returns the session profile', async () => {
    const { session, location } = await oidcLogin(env, 'ana.analyst@acme.test');
    expect(location).toBe('http://web.test/');
    expect(session).not.toBeNull();
    const me = await client(env.app, session).get('/v1/auth/session');
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({
      user: { email: 'ana.analyst@acme.test', roles: [{ id: 'analyst' }] },
      tenant: { slug: 'acme' },
    });
    expect(me.json().permissions).toContain('rag:query');
  });

  it('sends the authorization request with S256 PKCE, state and nonce', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/auth/login?tenant=acme&redirect_to=/cases' });
    const url = new URL(res.headers.location as string);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    expect(url.searchParams.get('redirect_uri')).toBe('http://api.test/v1/auth/callback');
  });

  it('rejects unknown, replayed and forged state values', async () => {
    const forged = await env.app.inject({ method: 'GET', url: '/v1/auth/callback?code=abc&state=forged' });
    expect(forged.headers.location).toBe('http://web.test/login?error=invalid_state');

    // capture a real callback and replay it
    const start = await env.app.inject({ method: 'GET', url: '/v1/auth/login?tenant=acme' });
    const authorize = new URL(start.headers.location as string);
    const form = new URLSearchParams(Object.fromEntries(authorize.searchParams));
    form.set('email', 'ana.analyst@acme.test');
    form.set('password', 'password');
    form.set('otp', '246810');
    form.set('decision', 'allow');
    const idp = await fetch(`${authorize.origin}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
    const cb = new URL(idp.headers.get('location')!);
    const first = await env.app.inject({ method: 'GET', url: cb.pathname + cb.search });
    expect(first.cookies.find((c) => c.name === 'fg_session')).toBeTruthy();
    const replay = await env.app.inject({ method: 'GET', url: cb.pathname + cb.search });
    expect(replay.headers.location).toBe('http://web.test/login?error=invalid_state');
  });

  it('rejects an authorization response from a different issuer', async () => {
    const start = await env.app.inject({ method: 'GET', url: '/v1/auth/login?tenant=acme' });
    const state = new URL(start.headers.location as string).searchParams.get('state');
    const res = await env.app.inject({
      method: 'GET',
      url: `/v1/auth/callback?code=x&state=${state}&iss=${encodeURIComponent('https://evil.example')}`,
    });
    expect(res.headers.location).toBe('http://web.test/login?error=invalid_issuer');
  });

  it('enforces the tenant MFA policy using amr', async () => {
    // Casey has no MFA enrolled at the IdP
    const { session, location } = await oidcLogin(env, 'casey.contractor@acme.test');
    expect(session).toBeNull();
    expect(location).toBe('http://web.test/login?error=mfa_required');
  });

  it('handles denied consent', async () => {
    const { session, location } = await oidcLogin(env, 'ana.analyst@acme.test', { decision: 'deny' });
    expect(session).toBeNull();
    expect(location).toBe('http://web.test/login?error=access_denied');
  });

  it('refuses identities that are not provisioned in the organization', async () => {
    const { location } = await oidcLogin(env, 'olga@globex.test', { tenant: 'acme' });
    expect(location).toBe('http://web.test/login?error=not_provisioned');
  });

  it('ignores open redirects in redirect_to', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/auth/login?tenant=acme&redirect_to=//evil.example' });
    const state = new URL(res.headers.location as string).searchParams.get('state');
    const row = await env.db.system((tx) => tx.one('select redirect_to from auth_flows where state = $1', [state]));
    expect(row?.redirect_to).toBe('/');
  });
});

describe('sessions and CSRF', () => {
  it('requires a CSRF token for state-changing requests', async () => {
    const session = await login(env, 'alex.admin@acme.test');
    const noCsrf = await env.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { cookie: session.cookie },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(noCsrf.json().code).toBe('csrf_failed');
    const ok = await client(env.app, session).post('/v1/auth/logout');
    expect(ok.statusCode).toBe(200);
    const after = await client(env.app, session).get('/v1/auth/session');
    expect(after.statusCode).toBe(401);
  });

  it('expires idle sessions', async () => {
    const session = await login(env, 'sam.analyst@acme.test');
    await env.db.system((tx) =>
      tx.query(`update sessions set last_seen_at = now() - interval '2 hours' where revoked_at is null and user_id = $1`, [
        acme.userIds['sam.analyst@acme.test'],
      ]),
    );
    const res = await client(env.app, session).get('/v1/auth/session');
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 without a session', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/auth/session' });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('unauthenticated');
  });
});

describe('user administration', () => {
  it('invites a user who is activated on first sign-in', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    // the sandbox has a user for this email but FinGraph does not yet
    await env.db.system((tx) => tx.query(`delete from users where email = 'dev.integrations@acme.test'`));
    const before = await oidcLogin(env, 'dev.integrations@acme.test');
    expect(before.location).toContain('not_provisioned');

    const inv = await admin.post('/v1/invitations', {
      email: 'dev.integrations@acme.test',
      display_name: 'Dana Park',
      roles: ['developer'],
    });
    expect(inv.statusCode).toBe(201);
    expect(inv.json().invitation.url).toContain('tenant=acme');

    const after = await oidcLogin(env, 'dev.integrations@acme.test');
    expect(after.session).not.toBeNull();
    const users = await admin.get('/v1/users');
    const dana = users.json().items.find((u: { email: string }) => u.email === 'dev.integrations@acme.test');
    expect(dana.status).toBe('active');
  });

  it('only lets admins manage users', async () => {
    const analyst = client(env.app, await login(env, 'ana.analyst@acme.test'));
    const res = await analyst.get('/v1/users');
    expect(res.statusCode).toBe(403);
  });

  it('deactivation revokes sessions immediately', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const auditorSession = await login(env, 'ivy.auditor@acme.test');
    const ivy = acme.userIds['ivy.auditor@acme.test']!;
    expect((await client(env.app, auditorSession).get('/v1/auth/session')).statusCode).toBe(200);
    const res = await admin.post(`/v1/users/${ivy}/deactivate`);
    expect(res.json().status).toBe('deactivated');
    expect((await client(env.app, auditorSession).get('/v1/auth/session')).statusCode).toBe(401);
    const relogin = await oidcLogin(env, 'ivy.auditor@acme.test');
    expect(relogin.location).toContain('account_deactivated');
    await admin.post(`/v1/users/${ivy}/reactivate`);
  });

  it('protects the last administrator', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const alex = acme.userIds['alex.admin@acme.test']!;
    const res = await admin.patch(`/v1/users/${alex}`, { roles: ['analyst'] });
    expect(res.statusCode).toBe(409);
    const self = await admin.post(`/v1/users/${alex}/deactivate`);
    expect(self.statusCode).toBe(403);
  });

  it('applies role changes to existing sessions', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const samSession = await login(env, 'sam.analyst@acme.test');
    const sam = acme.userIds['sam.analyst@acme.test']!;
    await admin.patch(`/v1/users/${sam}`, { roles: ['auditor'] });
    const me = await client(env.app, samSession).get('/v1/auth/session');
    expect(me.json().permissions).toContain('audit:export');
    expect(me.json().permissions).not.toContain('fact:review');
    await admin.patch(`/v1/users/${sam}`, { roles: ['analyst'] });
  });

  it('validates input with problem details', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const res = await admin.post('/v1/invitations', { email: 'not-an-email', display_name: '', roles: ['wizard'] });
    expect(res.statusCode).toBe(422);
    const paths = res.json().errors.map((e: { path: string }) => e.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.display_name', 'body.roles.0']));
  });

  it('updates tenant settings and records audit events', async () => {
    const admin = client(env.app, await login(env, 'alex.admin@acme.test'));
    const res = await admin.patch('/v1/tenant/settings', { session_idle_minutes: 45 });
    expect(res.json().settings.session_idle_minutes).toBe(45);
    expect(res.json().settings.require_mfa).toBe(true);
    const verify = await client(env.app, await login(env, 'rita.risk@acme.test')).get('/v1/audit/verify');
    expect(verify.json().valid).toBe(true);
    expect(verify.json().checked).toBeGreaterThan(5);
  });
});

describe('organization onboarding', () => {
  it('requires the platform token', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      payload: { slug: 'initech', name: 'Initech', admin_email: 'a@initech.test', admin_name: 'A' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates an organization with its first administrator', async () => {
    const res = await env.app.inject({
      method: 'POST',
      url: '/v1/organizations',
      headers: { 'x-platform-token': 'platform-token-0123456789abcdef' },
      payload: { slug: 'initech', name: 'Initech', admin_email: 'a@initech.test', admin_name: 'A' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().tenant.slug).toBe('initech');
  });
});

describe('tenant isolation', () => {
  it('never shows another organization’s users', async () => {
    const olga = client(env.app, await login(env, 'olga@globex.test', 'globex'));
    const res = await olga.get('/v1/users');
    expect(res.json().items.map((u: { email: string }) => u.email)).toEqual(['olga@globex.test']);
    const sam = acme.userIds['sam.analyst@acme.test'];
    const patch = await olga.patch(`/v1/users/${sam}`, { display_name: 'pwned' });
    expect(patch.statusCode).toBe(404);
  });
});
