import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../src/config';
import { assertDeliverableUrl, dispatchOutbox, signPayload, verifySignature } from '../src/modules/integrations/webhooks';
import { ACME_USERS, acmeClients, createTestEnv, seedTenant, type TestEnv } from './helpers';

let env: TestEnv;
let c: Awaited<ReturnType<typeof acmeClients>>;
let users: Record<string, string>;
let server: Server;
let url: string;
const received: { headers: Record<string, string>; body: string }[] = [];
let failNext = 0;

beforeAll(async () => {
  env = await createTestEnv({ sandbox: true });
  users = (await seedTenant(env.db, 'acme', ACME_USERS)).userIds;
  c = await acmeClients(env);
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, body });
      if (failNext > 0) {
        failNext--;
        res.writeHead(503).end();
      } else res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}/hook`;
});
afterAll(async () => {
  server.close();
  await env.close();
});

async function pump() {
  await dispatchOutbox(env.app.ctx);
  await env.app.worker.drain();
}

describe('webhooks', () => {
  let secret: string;
  let endpointId: string;

  it('registers an endpoint and returns the secret once', async () => {
    const res = await c.developer.post('/v1/webhooks', { url, event_types: ['case.review_assigned', 'case.review_completed'] });
    expect(res.statusCode).toBe(201);
    secret = res.json().secret;
    endpointId = res.json().id;
    expect(secret).toMatch(/^whsec_/);
    const list = await c.developer.get('/v1/webhooks');
    expect(JSON.stringify(list.json())).not.toContain(secret);
  });

  it('delivers matching events with a verifiable signature', async () => {
    await c.onboarding.post('/v1/cases', { subject_name: 'Hooked Inc', assignee_id: users['ana.analyst@acme.test'] });
    await c.onboarding.post('/v1/cases', { subject_name: 'No Event Inc' });
    await pump();
    expect(received).toHaveLength(1);
    const r = received[0]!;
    expect(r.headers['fingraph-event-type']).toBe('case.review_assigned');
    expect(verifySignature(secret, r.body, r.headers['fingraph-signature']!)).toBe(true);
    expect(verifySignature('whsec_wrong', r.body, r.headers['fingraph-signature']!)).toBe(false);
    const event = JSON.parse(r.body);
    expect(event).toMatchObject({ type: 'case.review_assigned', schema_version: expect.any(String), resource: { type: 'case' } });
    expect(event.id).toBe(r.headers['fingraph-event-id']);
  });

  it('retries failures with backoff and records attempts', async () => {
    received.length = 0;
    failNext = 2;
    await c.onboarding.post('/v1/cases', { subject_name: 'Flaky Receiver LLC', assignee_id: users['ana.analyst@acme.test'] });
    await pump();
    for (let i = 0; i < 2; i++) {
      await env.db.system((tx) => tx.query(`update jobs set run_at = now() where kind = 'deliver_webhook' and status = 'queued'`));
      await env.app.worker.drain();
    }
    expect(received).toHaveLength(3);
    // the same event id on every attempt lets receivers deduplicate
    expect(new Set(received.map((r) => r.headers['fingraph-event-id'])).size).toBe(1);
    const deliveries = (await c.developer.get(`/v1/webhooks/${endpointId}/deliveries`)).json().items;
    expect(deliveries[0]).toMatchObject({ status: 'succeeded', attempts: 3, last_status_code: 204 });
  });

  it('dead-letters after the maximum attempts and supports redelivery', async () => {
    received.length = 0;
    failNext = 100;
    await c.onboarding.post('/v1/cases', { subject_name: 'Down Receiver LLC', assignee_id: users['ana.analyst@acme.test'] });
    await pump();
    for (let i = 0; i < 8; i++) {
      await env.db.system((tx) => tx.query(`update jobs set run_at = now() where kind = 'deliver_webhook' and status = 'queued'`));
      await env.app.worker.drain();
    }
    const d = (await c.developer.get(`/v1/webhooks/${endpointId}/deliveries`)).json().items[0];
    expect(d).toMatchObject({ status: 'dead', attempts: 8, last_status_code: 503 });
    const alerts = (await c.admin.get('/v1/admin/alerts')).json();
    expect(alerts.alerts.some((a: { code: string }) => a.code === 'dead_jobs')).toBe(true);
    failNext = 0;
    await c.developer.post(`/v1/webhooks/${endpointId}/deliveries/${d.id}/redeliver`);
    await env.app.worker.drain();
    expect((await c.developer.get(`/v1/webhooks/${endpointId}/deliveries`)).json().items[0].status).toBe('succeeded');
  });

  it('sends test pings and rotates secrets', async () => {
    received.length = 0;
    await c.developer.post(`/v1/webhooks/${endpointId}/test`);
    await env.app.worker.drain();
    expect(JSON.parse(received[0]!.body).type).toBe('webhook.test');
    const rotated = (await c.developer.post(`/v1/webhooks/${endpointId}/rotate-secret`)).json().secret;
    await c.developer.post(`/v1/webhooks/${endpointId}/test`);
    await env.app.worker.drain();
    expect(verifySignature(rotated, received[1]!.body, received[1]!.headers['fingraph-signature']!)).toBe(true);
  });

  it('marks outbox events dispatched exactly once', async () => {
    const pending = await env.db.system((tx) => tx.one<{ n: number }>('select count(*)::int as n from outbox_events where dispatched_at is null'));
    expect(pending!.n).toBe(0);
    const again = await dispatchOutbox(env.app.ctx);
    expect(again).toEqual({ events: 0, deliveries: 0 });
  });

  it('is limited to developers and admins', async () => {
    expect((await c.analyst.get('/v1/webhooks')).statusCode).toBe(403);
  });
});

describe('webhook security', () => {
  it('rejects stale or tampered signatures', () => {
    const body = '{"a":1}';
    const old = signPayload('s', body, Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature('s', body, old)).toBe(false);
    expect(verifySignature('s', '{"a":2}', signPayload('s', body))).toBe(false);
  });

  it('blocks internal destinations in production', async () => {
    const prod = { ...testConfig(), NODE_ENV: 'production' as const, WEBHOOK_ALLOW_PRIVATE: undefined };
    await expect(assertDeliverableUrl(prod, 'http://example.com/hook')).rejects.toThrow(/https/);
    await expect(assertDeliverableUrl(prod, 'https://127.0.0.1/hook')).rejects.toThrow(/public/);
    await expect(assertDeliverableUrl(prod, 'https://10.1.2.3/hook')).rejects.toThrow(/public/);
    await expect(assertDeliverableUrl(prod, 'https://[::1]/hook')).rejects.toThrow(/public/);
    await expect(assertDeliverableUrl(prod, 'https://169.254.169.254/latest')).rejects.toThrow(/public/);
  });
});
