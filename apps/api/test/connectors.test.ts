import { DEV_OTP } from '@fingraph/sandbox';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACME_USERS, acmeClients, createTestEnv, seedTenant, type TestEnv } from './helpers';

let env: TestEnv;
let c: Awaited<ReturnType<typeof acmeClients>>;
let caseId: string;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  await seedTenant(env.db, 'acme', ACME_USERS);
  c = await acmeClients(env);
  caseId = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind Payments LLC' })).json().id;
});
afterAll(() => env.close());

async function connect(decision: 'allow' | 'deny' = 'allow') {
  const start = await c.admin.post('/v1/connections/sandbox_drive/authorize');
  expect(start.statusCode).toBe(200);
  const authorize = new URL(start.json().authorization_url);
  expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
  expect(authorize.searchParams.get('scope')).toBe('drive.readonly offline_access');
  const form = new URLSearchParams(Object.fromEntries(authorize.searchParams));
  form.set('email', 'alex.admin@acme.test');
  form.set('password', 'password');
  form.set('otp', DEV_OTP);
  form.set('decision', decision);
  const idp = await fetch(`${authorize.origin}/authorize`, { method: 'POST', body: form, redirect: 'manual' });
  const cb = new URL(idp.headers.get('location')!);
  const res = await env.app.inject({ method: 'GET', url: cb.pathname + cb.search });
  return new URL(res.headers.location as string);
}

const conn = async (id: string) => (await c.admin.get('/v1/connections')).json().items.find((x: { id: string }) => x.id === id);
const jobResult = async (id: string) => env.db.system((tx) => tx.one('select status, result, last_error from jobs where id = $1', [id]));

describe('OAuth repository connection (WF-02)', () => {
  let connectionId: string;

  it('handles denied consent without creating a connection', async () => {
    const result = await connect('deny');
    expect(result.searchParams.get('error')).toBe('access_denied');
    expect((await c.admin.get('/v1/connections')).json().items).toHaveLength(0);
  });

  it('connects with PKCE and stores tokens encrypted', async () => {
    const result = await connect();
    expect(result.pathname).toBe('/admin/integrations');
    expect(result.searchParams.get('connected')).toBe('sandbox_drive');
    connectionId = result.searchParams.get('connection')!;
    const row = await env.db.system((tx) => tx.one('select * from connections where id = $1', [connectionId]));
    expect(row).toMatchObject({ status: 'active', scopes: ['drive.readonly', 'offline_access'] });
    expect(row!.access_token_enc).toMatch(/^v1\./);
    expect(row!.refresh_token_enc).toMatch(/^v1\./);
    const listed = await conn(connectionId);
    expect(listed.access_token_enc).toBeUndefined();
  });

  it('rejects a replayed callback', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/v1/connections/sandbox_drive/callback?code=x&state=reused' });
    expect(new URL(res.headers.location as string).searchParams.get('error')).toBe('invalid_state');
  });

  it('browses repository files', async () => {
    const res = await c.onboarding.get(`/v1/connections/${connectionId}/files`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(4);
    expect(res.json().next_page_token).toBeTruthy();
  });

  it('imports every file into a case and processes it', async () => {
    const job = (await c.onboarding.post(`/v1/connections/${connectionId}/sync`, { case_id: caseId })).json().job_id;
    await env.app.worker.drain();
    expect(await jobResult(job)).toMatchObject({ status: 'succeeded', result: { imported: 8, skipped: 0 } });
    const docs = (await c.analyst.get(`/v1/documents?case_id=${caseId}`)).json().items;
    expect(docs).toHaveLength(8);
    expect(docs.every((d: { source: string; status: string }) => d.source === 'connector' && d.status === 'processed')).toBe(true);
    expect((await conn(connectionId)).last_sync_at).toBeTruthy();
  });

  it('skips unchanged files and imports edits as new versions', async () => {
    const again = (await c.onboarding.post(`/v1/connections/${connectionId}/sync`, { case_id: caseId })).json().job_id;
    await env.app.worker.drain();
    expect((await jobResult(again))!.result).toEqual({ imported: 0, skipped: 8 });

    await fetch(`${env.config.SANDBOX_URL}/drive/v1/_sandbox/touch/f-bank`, { method: 'POST' });
    const third = (await c.onboarding.post(`/v1/connections/${connectionId}/sync`, { case_id: caseId })).json().job_id;
    await env.app.worker.drain();
    expect((await jobResult(third))!.result).toEqual({ imported: 1, skipped: 7 });
    const docs = (await c.analyst.get(`/v1/documents?case_id=${caseId}`)).json().items;
    expect(docs).toHaveLength(8);
    const bank = docs.find((d: { category: string }) => d.category === 'bank_statement');
    expect(bank.version_no).toBe(2);
  });

  it('refreshes expired access tokens with rotation', async () => {
    const before = await env.db.system((tx) => tx.one('select refresh_token_enc from connections where id = $1', [connectionId]));
    await env.db.system((tx) => tx.query(`update connections set expires_at = now() - interval '1 minute' where id = $1`, [connectionId]));
    const res = await c.onboarding.get(`/v1/connections/${connectionId}/files`);
    expect(res.statusCode).toBe(200);
    const after = await env.db.system((tx) => tx.one('select refresh_token_enc, expires_at from connections where id = $1', [connectionId]));
    expect(after!.refresh_token_enc).not.toBe(before!.refresh_token_enc);
    expect(new Date(after!.expires_at).getTime()).toBeGreaterThan(Date.now());
  });

  it('resumes an interrupted import from the last completed page', async () => {
    const other = (await c.onboarding.post('/v1/cases', { subject_name: 'Northwind refresh' })).json().id;
    const provider = env.app.ctx.connectors.get('sandbox_drive')!;
    const original = provider.download.bind(provider);
    let calls = 0;
    provider.download = async (t, id) => {
      calls++;
      if (calls === 6) throw new Error('connection reset');
      return original(t, id);
    };
    try {
      const job = (await c.onboarding.post(`/v1/connections/${connectionId}/sync`, { case_id: other })).json().job_id;
      await env.app.worker.drain();
      expect((await jobResult(job))!.status).toBe('queued');
      const state = (await conn(connectionId)).sync_state;
      expect(state.imported).toBe(4);
      await env.db.system((tx) => tx.query('update jobs set run_at = now() where id = $1', [job]));
      await env.app.worker.drain();
      // the file imported just before the failure is recognized and not imported twice
      expect((await jobResult(job))!.result).toEqual({ imported: 7, skipped: 1 });
    } finally {
      provider.download = original;
    }
    expect((await c.analyst.get(`/v1/documents?case_id=${other}`)).json().items).toHaveLength(8);
  });

  it('marks the connection expired when the provider revokes access', async () => {
    const second = new URL((await connect()).toString()).searchParams.get('connection')!;
    for (const rt of env.sandbox!.state.refreshTokens.values()) rt.revoked = true;
    await env.db.system((tx) => tx.query(`update connections set expires_at = now() - interval '1 minute' where id = $1`, [second]));
    const job = (await c.onboarding.post(`/v1/connections/${second}/sync`, { case_id: caseId })).json().job_id;
    await env.app.worker.drain();
    expect(await jobResult(job)).toMatchObject({ status: 'failed', last_error: { type: 'reauthorization_required' } });
    expect((await conn(second)).status).toBe('expired');
    expect((await c.onboarding.post(`/v1/connections/${second}/sync`, { case_id: caseId })).statusCode).toBe(409);
  });

  it('revokes a connection: tokens deleted, provider notified, future imports stop (US-07)', async () => {
    const third = (await connect()).searchParams.get('connection')!;
    const res = await c.admin.post(`/v1/connections/${third}/revoke`);
    expect(res.json().status).toBe('revoked');
    const row = await env.db.system((tx) => tx.one('select access_token_enc, refresh_token_enc from connections where id = $1', [third]));
    expect(row).toEqual({ access_token_enc: null, refresh_token_enc: null });
    const live = [...env.sandbox!.state.refreshTokens.values()].filter((t) => !t.revoked);
    expect(live).toHaveLength(0);
    expect((await c.onboarding.post(`/v1/connections/${third}/sync`, { case_id: caseId })).statusCode).toBe(409);
    const events = await env.db.system((tx) => tx.many(`select type from outbox_events where type = 'connection.revoked'`));
    expect(events).toHaveLength(1);
    // previously imported documents are governed by retention, not deleted
    expect((await c.analyst.get(`/v1/documents?case_id=${caseId}`)).json().items).toHaveLength(8);
  });

  it('only lets administrators manage connections', async () => {
    expect((await c.analyst.post('/v1/connections/sandbox_drive/authorize')).statusCode).toBe(403);
    expect((await c.onboarding.post(`/v1/connections/${connectionId}/revoke`)).statusCode).toBe(403);
  });
});
