import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { EVENT_TYPES } from '@fingraph/shared';
import { notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { enqueue } from '../jobs/queue';
import { assertDeliverableUrl, newWebhookSecret, sealSecret, WEBHOOK_JOB } from './webhooks';

const eventTypes = z.array(z.union([z.enum(EVENT_TYPES), z.literal('*')])).min(1);
const ENDPOINT_COLUMNS = 'id, url, description, event_types, status, consecutive_failures, created_at, updated_at';

export async function webhookRoutes(app: FastifyInstance) {
  const { config } = app.ctx;

  const checkUrl = async (url: string) => {
    try {
      await assertDeliverableUrl(config, url);
    } catch (err) {
      throw unprocessable('invalid_webhook_url', (err as Error).message);
    }
  };

  route(app, {
    method: 'POST',
    url: '/v1/webhooks',
    summary: 'Register a webhook endpoint (the signing secret is shown once)',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    status: 201,
    body: z.object({ url: z.url().max(2000), description: z.string().trim().max(200).optional(), event_types: eventTypes }),
    handler: async ({ body, auth, req, tx }) => {
      await checkUrl(body.url);
      return tx(async (t) => {
        const secret = newWebhookSecret();
        const row = await t.one(
          `insert into webhook_endpoints (tenant_id, url, description, event_types, secret_enc, created_by)
           values ($1,$2,$3,$4,$5,$6) returning ${ENDPOINT_COLUMNS}`,
          [auth.tenantId, body.url, body.description ?? null, body.event_types, sealSecret(config, auth.tenantId, secret), auth.userId],
        );
        await audit(t, req, { action: 'webhook.created', resourceType: 'webhook', resourceId: row!.id, details: { url: body.url, event_types: body.event_types } });
        return { ...row, secret };
      });
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/webhooks',
    summary: 'Webhook endpoints',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    handler: async ({ tx }) => ({
      items: await tx((t) =>
        t.many(
          `select ${ENDPOINT_COLUMNS},
                  (select count(*)::int from webhook_deliveries d where d.endpoint_id = e.id and d.status = 'dead') as dead_deliveries,
                  (select max(delivered_at) from webhook_deliveries d where d.endpoint_id = e.id) as last_delivered_at
             from webhook_endpoints e order by created_at desc`,
        ),
      ),
      event_types: EVENT_TYPES,
    }),
  });

  route(app, {
    method: 'PATCH',
    url: '/v1/webhooks/:id',
    summary: 'Change a webhook endpoint',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    params: uuidParam,
    body: z.object({ url: z.url().max(2000), description: z.string().trim().max(200).nullable(), event_types: eventTypes, status: z.enum(['active', 'disabled']) }).partial(),
    handler: async ({ params, body, req, tx }) => {
      if (body.url) await checkUrl(body.url);
      return tx(async (t) => {
        const row = await t.one(
          `update webhook_endpoints set url = coalesce($2, url), description = coalesce($3, description),
                  event_types = coalesce($4, event_types), status = coalesce($5, status),
                  consecutive_failures = case when $5 = 'active' then 0 else consecutive_failures end
            where id = $1 returning ${ENDPOINT_COLUMNS}`,
          [params.id, body.url ?? null, body.description ?? null, body.event_types ?? null, body.status ?? null],
        );
        if (!row) throw notFound('Webhook');
        await audit(t, req, { action: 'webhook.updated', resourceType: 'webhook', resourceId: params.id, details: body });
        return row;
      });
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/webhooks/:id/rotate-secret',
    summary: 'Rotate the signing secret',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const secret = newWebhookSecret();
        const r = await t.query('update webhook_endpoints set secret_enc = $2 where id = $1', [params.id, sealSecret(config, auth.tenantId, secret)]);
        if (!r.rowCount) throw notFound('Webhook');
        await audit(t, req, { action: 'webhook.secret_rotated', resourceType: 'webhook', resourceId: params.id });
        return { id: params.id, secret };
      }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/webhooks/:id',
    summary: 'Delete a webhook endpoint',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    params: uuidParam,
    handler: async ({ params, req, tx }) =>
      tx(async (t) => {
        const r = await t.query('delete from webhook_endpoints where id = $1', [params.id]);
        if (!r.rowCount) throw notFound('Webhook');
        await audit(t, req, { action: 'webhook.deleted', resourceType: 'webhook', resourceId: params.id });
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/webhooks/:id/deliveries',
    summary: 'Recent deliveries for an endpoint',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    params: uuidParam,
    handler: async ({ params, tx }) =>
      tx(async (t) => {
        const ep = await t.one('select id from webhook_endpoints where id = $1', [params.id]);
        if (!ep) throw notFound('Webhook');
        return {
          items: await t.many(
            `select id, event_id, event_type, status, attempts, last_status_code, last_error, last_attempt_at, delivered_at, created_at
               from webhook_deliveries where endpoint_id = $1 order by created_at desc limit 100`,
            [params.id],
          ),
        };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/webhooks/:id/deliveries/:deliveryId/redeliver',
    summary: 'Send a delivery again',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    status: 202,
    params: z.object({ id: z.uuid(), deliveryId: z.uuid() }),
    handler: async ({ params, auth, req, tx }) =>
      tx(async (t) => {
        const d = await t.one(`update webhook_deliveries set status = 'pending' where id = $1 and endpoint_id = $2 returning id`, [params.deliveryId, params.id]);
        if (!d) throw notFound('Delivery');
        const job = await enqueue(t, { tenantId: auth.tenantId, kind: WEBHOOK_JOB, payload: { delivery_id: d.id }, maxAttempts: 8, resource: { type: 'webhook_delivery', id: d.id } });
        await audit(t, req, { action: 'webhook.redelivered', resourceType: 'webhook', resourceId: params.id, details: { delivery_id: d.id } });
        return { job_id: job.id };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/webhooks/:id/test',
    summary: 'Send a test event to the endpoint',
    tags: ['developers'],
    permission: 'webhook:manage',
    scopes: ['webhooks:manage'],
    status: 202,
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const ep = await t.one<{ id: string }>('select id from webhook_endpoints where id = $1', [params.id]);
        if (!ep) throw notFound('Webhook');
        const event = {
          id: crypto.randomUUID(),
          type: 'webhook.test',
          tenant_id: auth.tenantId,
          occurred_at: new Date().toISOString(),
          schema_version: '2024-04-01',
          correlation_id: null,
          resource: { type: 'webhook', id: ep.id },
          data: { message: 'Test delivery from FinGraph' },
        };
        const d = await t.one<{ id: string }>(
          `insert into webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) values ($1,$2,$3,$4,$5) returning id`,
          [auth.tenantId, ep.id, event.id, event.type, JSON.stringify(event)],
        );
        await enqueue(t, { tenantId: auth.tenantId, kind: WEBHOOK_JOB, payload: { delivery_id: d!.id }, maxAttempts: 1, resource: { type: 'webhook_delivery', id: d!.id } });
        return { delivery_id: d!.id };
      }),
  });
}
