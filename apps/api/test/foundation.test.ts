import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/db/migrate';
import { createTestEnv, type TestEnv } from './helpers';

let env: TestEnv;

beforeAll(async () => {
  env = await createTestEnv();
});
afterAll(async () => {
  await env.close();
});

describe('foundation', () => {
  it('serves liveness and readiness probes', async () => {
    const live = await env.app.inject({ method: 'GET', url: '/healthz' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    const ready = await env.app.inject({ method: 'GET', url: '/readyz' });
    expect(ready.json()).toMatchObject({ database: 'ok' });
  });

  it('echoes a valid correlation id and generates one otherwise', async () => {
    const a = await env.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': 'abc12345-test' },
    });
    expect(a.headers['x-correlation-id']).toBe('abc12345-test');
    const b = await env.app.inject({
      method: 'GET',
      url: '/healthz',
      headers: { 'x-correlation-id': 'bad id with spaces' },
    });
    expect(b.headers['x-correlation-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('returns problem+json for unknown routes', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/problem+json');
    expect(res.json()).toMatchObject({ code: 'not_found', status: 404 });
  });

  it('re-running migrations is a no-op', async () => {
    expect(await migrate(env.db)).toEqual([]);
  });

  it('isolates tenants with row level security', async () => {
    const [a, b] = await env.db.system(async (tx) => {
      const t1 = await tx.one<{ id: string }>(
        `insert into tenants (slug, name) values ('rls-a', 'A') returning id`,
      );
      const t2 = await tx.one<{ id: string }>(
        `insert into tenants (slug, name) values ('rls-b', 'B') returning id`,
      );
      await tx.query(`insert into users (tenant_id, email, display_name) values ($1, 'a@a.test', 'A')`, [t1!.id]);
      await tx.query(`insert into users (tenant_id, email, display_name) values ($1, 'b@b.test', 'B')`, [t2!.id]);
      return [t1!.id, t2!.id];
    });

    const seen = await env.db.tenant(a!, (tx) => tx.many<{ email: string }>('select email from users'));
    expect(seen.map((u) => u.email)).toEqual(['a@a.test']);

    const tenants = await env.db.tenant(a!, (tx) => tx.many('select id from tenants'));
    expect(tenants).toHaveLength(1);

    // writes into another tenant are rejected by the policy check
    await expect(
      env.db.tenant(a!, (tx) =>
        tx.query(`insert into users (tenant_id, email, display_name) values ($1, 'x@x.test', 'X')`, [b]),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('serves the OpenAPI document', async () => {
    const res = await env.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(res.json().openapi).toBe('3.0.3');
  });
});

describe('metrics', () => {
  it('exposes Prometheus metrics outside production', async () => {
    await env.app.inject({ method: 'GET', url: '/healthz' });
    const res = await env.app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('fingraph_http_requests_total{method="GET",route="/healthz",status="2xx"}');
    expect(res.body).toContain('fingraph_outbox_pending 0');
  });
});
