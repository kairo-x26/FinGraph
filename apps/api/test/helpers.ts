import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { createSandbox, DEV_OTP, type Sandbox } from '@fingraph/sandbox';
import type { Role } from '@fingraph/shared';
import { buildApp } from '../src/app';
import { testConfig, type Config } from '../src/config';
import { createDatabase, type Database } from '../src/db';
import { migrate } from '../src/db/migrate';

export const API_BASE = 'http://api.test';

export interface TestEnv {
  app: FastifyInstance;
  db: Database;
  config: Config;
  sandbox: Sandbox | null;
  close: () => Promise<void>;
}

export async function createTestDb(): Promise<Database> {
  const db = await createDatabase('pglite://memory');
  await migrate(db);
  return db;
}

export interface EnvOptions {
  config?: Parameters<typeof testConfig>[0];
  /** Start the sandbox IdP and point the API at it. */
  sandbox?: boolean;
}

export async function createTestEnv(opts: EnvOptions = {}): Promise<TestEnv> {
  let sandbox: Sandbox | null = null;
  const overrides: Record<string, string> = { PUBLIC_API_URL: API_BASE, WEB_URL: 'http://web.test', ...opts.config };
  if (opts.sandbox) {
    sandbox = await createSandbox({ apiCallbackBase: API_BASE });
    const url = await sandbox.listen(0);
    overrides.OIDC_ISSUER = url;
    overrides.SANDBOX_URL = url;
  }
  const config = testConfig(overrides);
  const db = await createTestDb();
  const app = await buildApp({ config, db });
  await app.ready();
  return {
    app,
    db,
    config,
    sandbox,
    close: async () => {
      await app.close();
      await sandbox?.app.close();
      await db.close();
    },
  };
}

export interface SeedUser {
  email: string;
  name: string;
  roles: Role[];
  status?: 'active' | 'invited' | 'deactivated';
}

export async function seedTenant(
  db: Database,
  slug: string,
  users: SeedUser[],
  settings: Record<string, unknown> = {},
) {
  return db.system(async (tx) => {
    const tenant = await tx.one<{ id: string }>(
      'insert into tenants (slug, name, settings) values ($1, $2, $3) returning id',
      [slug, slug.toUpperCase(), JSON.stringify(settings)],
    );
    const ids: Record<string, string> = {};
    for (const u of users) {
      const row = await tx.one<{ id: string }>(
        `insert into users (tenant_id, email, display_name, roles, status) values ($1, $2, $3, $4, $5) returning id`,
        [tenant!.id, u.email, u.name, u.roles, u.status ?? 'active'],
      );
      ids[u.email] = row!.id;
    }
    return { tenantId: tenant!.id, userIds: ids };
  });
}

export const ACME_USERS: SeedUser[] = [
  { email: 'alex.admin@acme.test', name: 'Alex Morgan', roles: ['admin'] },
  { email: 'ana.analyst@acme.test', name: 'Ana Ruiz', roles: ['analyst'] },
  { email: 'sam.analyst@acme.test', name: 'Sam Okafor', roles: ['analyst'] },
  { email: 'rita.risk@acme.test', name: 'Rita Chen', roles: ['risk_manager'] },
  { email: 'omar.onboarding@acme.test', name: 'Omar Haddad', roles: ['onboarding'] },
  { email: 'ivy.auditor@acme.test', name: 'Ivy Lindqvist', roles: ['auditor'] },
  { email: 'dev.integrations@acme.test', name: 'Dana Park', roles: ['developer'] },
  { email: 'casey.contractor@acme.test', name: 'Casey Lee', roles: ['onboarding'] },
];

export interface Session {
  cookie: string;
  csrf: string;
}

function cookiesFrom(res: LightMyRequestResponse): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of res.cookies) out[c.name] = c.value;
  return out;
}

/** Runs the full browser sign-in: API → sandbox authorize → API callback. */
export async function oidcLogin(
  env: TestEnv,
  email: string,
  opts: { tenant?: string; otp?: string; decision?: 'allow' | 'deny' } = {},
): Promise<{ session: Session | null; location: string }> {
  const start = await env.app.inject({ method: 'GET', url: `/v1/auth/login?tenant=${opts.tenant ?? 'acme'}` });
  if (start.statusCode !== 302) throw new Error(`login start failed: ${start.statusCode} ${start.body}`);
  const authorize = new URL(start.headers.location as string);
  if (!authorize.pathname.endsWith('/authorize')) return { session: null, location: authorize.toString() };
  const form = new URLSearchParams(Object.fromEntries(authorize.searchParams));
  form.set('email', email);
  form.set('password', 'password');
  form.set('otp', opts.otp ?? DEV_OTP);
  form.set('decision', opts.decision ?? 'allow');
  const idpRes = await fetch(`${authorize.origin}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
  const callback = new URL(idpRes.headers.get('location') ?? '');
  const cb = await env.app.inject({ method: 'GET', url: `${callback.pathname}${callback.search}` });
  const location = cb.headers.location as string;
  const cookies = cookiesFrom(cb);
  if (!cookies.fg_session) return { session: null, location };
  return { session: { cookie: `fg_session=${cookies.fg_session}`, csrf: cookies.fg_csrf! }, location };
}

export async function login(env: TestEnv, email: string, tenant = 'acme'): Promise<Session> {
  const { session, location } = await oidcLogin(env, email, { tenant });
  if (!session) throw new Error(`login failed for ${email}: ${location}`);
  return session;
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export function client(app: FastifyInstance, session: Session | null) {
  const call = (method: Method, url: string, payload?: unknown, headers: Record<string, string> = {}) => {
    const opts: InjectOptions = {
      method,
      url,
      headers: {
        ...(session ? { cookie: session.cookie, 'x-csrf-token': session.csrf } : {}),
        ...headers,
      },
    };
    if (payload !== undefined) {
      if (Buffer.isBuffer(payload)) opts.payload = payload;
      else opts.payload = payload as InjectOptions['payload'];
    }
    return app.inject(opts);
  };
  return {
    get: (url: string, headers?: Record<string, string>) => call('GET', url, undefined, headers),
    post: (url: string, body?: unknown, headers?: Record<string, string>) => call('POST', url, body ?? {}, headers),
    put: (url: string, body?: unknown, headers?: Record<string, string>) => call('PUT', url, body ?? {}, headers),
    patch: (url: string, body?: unknown, headers?: Record<string, string>) => call('PATCH', url, body ?? {}, headers),
    delete: (url: string, body?: unknown, headers?: Record<string, string>) => call('DELETE', url, body, headers),
  };
}

/** Logs in every seeded ACME user and returns API clients keyed by role. */
export async function acmeClients(env: TestEnv) {
  const by = async (email: string) => client(env.app, await login(env, email));
  return {
    admin: await by('alex.admin@acme.test'),
    analyst: await by('ana.analyst@acme.test'),
    analyst2: await by('sam.analyst@acme.test'),
    risk: await by('rita.risk@acme.test'),
    onboarding: await by('omar.onboarding@acme.test'),
    auditor: await by('ivy.auditor@acme.test'),
    developer: await by('dev.integrations@acme.test'),
  };
}

export type Client = ReturnType<typeof client>;

/** Signed-URL upload + registration, like the web app does it. */
export async function uploadDocument(
  app: FastifyInstance,
  c: Client,
  caseId: string,
  file: { filename: string; mime: string; bytes: Buffer },
  extra: Record<string, unknown> = {},
) {
  const init = await c.post('/v1/documents/uploads', {
    case_id: caseId,
    filename: file.filename,
    mime_type: file.mime,
    size_bytes: file.bytes.length,
  });
  if (init.statusCode !== 201) return init;
  const url = new URL(init.json().upload_url);
  const put = await app.inject({
    method: 'PUT',
    url: url.pathname + url.search,
    headers: { 'content-type': 'application/octet-stream' },
    payload: file.bytes,
  });
  if (put.statusCode !== 200) return put;
  return c.post('/v1/documents', { upload_id: init.json().upload_id, ...extra });
}

/** Approves every candidate critical fact in a case (as the given reviewer). */
export async function approveCriticalFacts(c: Client, caseId: string) {
  const facts = (await c.get(`/v1/cases/${caseId}/facts?critical=true&status=candidate`)).json().items as { id: string }[];
  for (const f of facts) await c.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' });
  return facts.length;
}
