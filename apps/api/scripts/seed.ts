/**
 * Seeds a demo organization ("acme") whose users match the sandbox IdP accounts,
 * plus a second organization ("globex") for tenant-isolation demos. Documents go
 * through the real API and ingestion pipeline.
 *
 *   pnpm --filter @fingraph/api seed            # seed if empty
 *   pnpm --filter @fingraph/api seed -- --reset # drop the demo tenants first
 */
import { extraFixtures, globexIncorporation, northwindFixtures } from '@fingraph/fixtures';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig } from '../src/config';
import { createDatabase } from '../src/db';
import { migrate } from '../src/db/migrate';
import { createSession } from '../src/modules/identity/sessions';
import type { TenantRow } from '../src/modules/identity/tenants';

const ACME = [
  ['alex.admin@acme.test', 'Alex Morgan', ['admin']],
  ['ana.analyst@acme.test', 'Ana Ruiz', ['analyst']],
  ['sam.analyst@acme.test', 'Sam Okafor', ['analyst']],
  ['rita.risk@acme.test', 'Rita Chen', ['risk_manager']],
  ['omar.onboarding@acme.test', 'Omar Haddad', ['onboarding']],
  ['ivy.auditor@acme.test', 'Ivy Lindqvist', ['auditor']],
  ['dev.integrations@acme.test', 'Dana Park', ['developer']],
] as const;

const config = loadConfig({ ...process.env, WORKER_INLINE: 'false', LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn' });
const db = await createDatabase(config.DATABASE_URL, 2);
await migrate(db);

if (process.argv.includes('--reset')) {
  await db.system(async (tx) => {
    await tx.query(`alter table audit_events disable trigger audit_events_no_update`);
    await tx.query(`alter table review_decisions disable trigger review_decisions_immutable`);
    await tx.query(`delete from audit_events where tenant_id in (select id from tenants where slug in ('acme', 'globex'))`);
    await tx.query(`delete from tenants where slug in ('acme', 'globex')`);
    await tx.query(`alter table audit_events enable trigger audit_events_no_update`);
    await tx.query(`alter table review_decisions enable trigger review_decisions_immutable`);
  });
  console.log('removed demo tenants');
}

const exists = await db.system((tx) => tx.one(`select 1 from tenants where slug = 'acme'`));
if (exists) {
  console.log('demo data already present (use --reset to recreate)');
  await db.close();
  process.exit(0);
}

const app = await buildApp({ config, db });
await app.ready();

async function seedTenant(slug: string, name: string, users: readonly (readonly [string, string, readonly string[]])[]) {
  return db.system(async (tx) => {
    const t = await tx.one<TenantRow>(`insert into tenants (slug, name, settings) values ($1, $2, $3) returning *`, [
      slug,
      name,
      JSON.stringify({ require_mfa: true, allowed_email_domains: [`${slug}.test`] }),
    ]);
    const ids: Record<string, string> = {};
    for (const [email, display, roles] of users) {
      const u = await tx.one<{ id: string }>(
        `insert into users (tenant_id, email, display_name, roles) values ($1,$2,$3,$4) returning id`,
        [t!.id, email, display, roles],
      );
      ids[email] = u!.id;
    }
    return { tenant: t!, ids };
  });
}

/** An API client acting as a user, without going through the browser SSO flow. */
async function as(tenant: TenantRow, userId: string) {
  const s = await db.tenant(tenant.id, (tx) => createSession(tx, config, tenant, { tenantId: tenant.id, userId, amr: ['pwd', 'mfa'] }));
  const headers = { cookie: `fg_session=${s.token}`, 'x-csrf-token': s.csrf };
  const call = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url, headers, payload: payload as object });
    if (res.statusCode >= 400) throw new Error(`${method} ${url} → ${res.statusCode} ${res.body}`);
    return res.json();
  };
  return {
    get: (url: string) => call('GET', url),
    post: (url: string, body: unknown = {}) => call('POST', url, body),
    patch: (url: string, body: unknown) => call('PATCH', url, body),
    async upload(caseId: string, file: { filename: string; mime: string; bytes: Buffer }, extra: Record<string, unknown> = {}) {
      const init = await call('POST', '/v1/documents/uploads', { case_id: caseId, filename: file.filename, mime_type: file.mime, size_bytes: file.bytes.length });
      // the signed URL is public-facing (it may include the web proxy prefix); call the API route directly
      const local = String(init.upload_url).slice(config.PUBLIC_API_URL.length);
      await app.inject({ method: 'PUT', url: local, headers: { 'content-type': 'application/octet-stream' }, payload: file.bytes });
      return call('POST', '/v1/documents', { upload_id: init.upload_id, ...extra });
    },
  };
}

const drain = () => app.worker.drain(5000);

const { tenant: acme, ids } = await seedTenant('acme', 'Acme Fintech', ACME);
const { tenant: globex, ids: gids } = await seedTenant('globex', 'Globex Treasury', [['olga@globex.test', 'Olga Petrova', ['admin', 'analyst', 'risk_manager']]]);

const omar = await as(acme, ids['omar.onboarding@acme.test']!);
const ana = await as(acme, ids['ana.analyst@acme.test']!);
const rita = await as(acme, ids['rita.risk@acme.test']!);
const sam = await as(acme, ids['sam.analyst@acme.test']!);
const fx = Object.fromEntries([...(await northwindFixtures()), ...(await extraFixtures())].map((f) => [f.key, f]));

// 1. Northwind: a full KYB file in review, with an undeclared indirect owner to find
const northwind = await omar.post('/v1/cases', {
  case_type: 'kyb_onboarding',
  subject_name: 'Northwind Payments LLC',
  customer_ref: 'CUST-10442',
  risk_level: 'high',
  assignee_id: ids['ana.analyst@acme.test'],
  due_at: new Date(Date.now() + 5 * 86_400_000).toISOString(),
});
for (const k of ['formation', 'ubo', 'directors', 'bank', 'tax', 'structure', 'ubo_old', 'letter']) await omar.upload(northwind.id, fx[k]!);
await drain();
await ana.post(`/v1/cases/${northwind.id}/start-review`);
const nwFacts = (await ana.get(`/v1/documents?case_id=${northwind.id}`)).items as { id: string; category: string }[];
for (const d of nwFacts.filter((x) => ['certificate_of_incorporation', 'tax_form'].includes(x.category))) {
  const facts = (await ana.get(`/v1/documents/${d.id}/extractions`)).facts as { id: string; critical: boolean }[];
  for (const f of facts.filter((x) => x.critical)) await ana.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' });
}
await ana.post(`/v1/cases/${northwind.id}/notes`, { body: 'Group chart shows Harbor Capital Partners as GP of Harbor Ventures. Need to confirm whether Thomas Reid should be declared.' });
await ana.post(`/v1/cases/${northwind.id}/questions`, { question: 'Which individuals are listed as beneficial owners of this company, and which documents support those relationships?' });

// 2. Bayside: new, unassigned, waiting for documents
const bayside = await omar.post('/v1/cases', { subject_name: 'Bayside Remit Inc', customer_ref: 'CUST-10458', risk_level: 'medium' });
await omar.upload(bayside.id, { filename: 'bayside-w9.txt', mime: 'text/plain', bytes: Buffer.from('Form W-9\nName of entity: Bayside Remit Inc\nEmployer identification number: 46-5512093\nDate: 2024-08-30\n') });
await omar.post(`/v1/cases/${bayside.id}/requests`, { item_key: 'ubo', message: 'Please send the signed beneficial ownership certification.' });

// 3. Lakeshore: low risk refresh, approved
const lakeshore = await omar.post('/v1/cases', { case_type: 'kyb_refresh', subject_name: 'Northwind Payments LLC', customer_ref: 'CUST-10442', risk_level: 'low', assignee_id: ids['sam.analyst@acme.test'] });
for (const k of ['ubo', 'directors', 'bank']) await omar.upload(lakeshore.id, fx[k]!);
await drain();
await sam.post(`/v1/cases/${lakeshore.id}/start-review`);
const lsFacts = (await sam.get(`/v1/cases/${lakeshore.id}/facts?critical=true&status=candidate`)).items as { id: string }[];
for (const f of lsFacts) await sam.post(`/v1/extracted-facts/${f.id}/reviews`, { action: 'approve' });
const ready = await sam.get(`/v1/cases/${lakeshore.id}/readiness`);
if (ready.can_approve) {
  await sam.post(`/v1/cases/${lakeshore.id}/recommendation`, { outcome: 'approve', rationale: 'Annual refresh: ownership unchanged, statement current, directors unchanged.' });
  const after = await sam.get(`/v1/cases/${lakeshore.id}`);
  if (['pending_approval', 'escalated'].includes(after.status)) {
    await rita.post(`/v1/cases/${lakeshore.id}/approval`, { decision: 'approve', rationale: 'Reviewed indirect ownership via Harbor Ventures; acceptable for low-risk refresh.' });
  }
}

// 4. Globex: another tenant's data, invisible to Acme
const g = await as(globex, gids['olga@globex.test']!);
const gc = await g.post('/v1/cases', { subject_name: 'Globex Treasury Inc.', risk_level: 'low' });
await g.upload(gc.id, { filename: 'globex-articles.pdf', mime: 'application/pdf', bytes: await globexIncorporation() });
await drain();

console.log(`seeded acme (${Object.keys(ids).length} users, 3 cases) and globex`);
console.log('sign in at http://localhost:3000/login with organization "acme"; sandbox password "password", one-time code 246810');
await app.close();
await db.close();
