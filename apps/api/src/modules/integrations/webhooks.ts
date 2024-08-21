import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { AppContext } from '../../context';
import type { Config } from '../../config';
import { decrypt, deriveKey, encrypt, hmacHex, randomToken } from '../../lib/crypto';
import { toDomainEvent, type OutboxRow } from '../events/outbox';
import { RetryableJobError, PermanentJobError } from '../jobs/errors';
import { enqueue } from '../jobs/queue';
import type { JobContext } from '../jobs/worker';

export const WEBHOOK_JOB = 'deliver_webhook';
const MAX_ATTEMPTS = 8;
const DISABLE_AFTER = 50;

const secretKey = (config: Config) => deriveKey(config.APP_SECRET, 'webhook-secret');
export const newWebhookSecret = () => `whsec_${randomToken(32)}`;
export const sealSecret = (config: Config, tenantId: string, secret: string) => encrypt(secretKey(config), secret, tenantId);
export const openSecret = (config: Config, tenantId: string, enc: string) => decrypt(secretKey(config), enc, tenantId);

/** `t=<unix>,v1=<hex hmac-sha256 of "t.body">` (verify with a 5 minute tolerance). */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)) {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${body}`)}`;
}

export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, now = Date.now()) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!t || Math.abs(now / 1000 - t) > toleranceSec) return false;
  return parts.v1 === hmacHex(secret, `${t}.${body}`);
}

const PRIVATE = new BlockList();
for (const [net, bits] of [['10.0.0.0', 8], ['172.16.0.0', 12], ['192.168.0.0', 16], ['127.0.0.0', 8], ['169.254.0.0', 16], ['0.0.0.0', 8], ['100.64.0.0', 10]] as const) {
  PRIVATE.addSubnet(net, bits, 'ipv4');
}
for (const [net, bits] of [['::1', 128], ['fc00::', 7], ['fe80::', 10], ['::', 128]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** Rejects URLs that point at internal networks (SSRF) unless explicitly allowed. */
export async function assertDeliverableUrl(config: Config, raw: string) {
  const url = new URL(raw);
  const allowPrivate = config.WEBHOOK_ALLOW_PRIVATE ?? config.NODE_ENV !== 'production';
  if (url.protocol !== 'https:' && !(allowPrivate && url.protocol === 'http:')) throw new Error('Webhook URLs must use https.');
  if (allowPrivate) return;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const a of addresses) {
    if (PRIVATE.check(a.address, a.family === 6 ? 'ipv6' : 'ipv4')) throw new Error('Webhook URLs must resolve to a public address.');
  }
}

/**
 * Moves undispatched outbox events into webhook deliveries (one per matching
 * endpoint) and marks them dispatched. Runs continuously in the worker.
 */
export async function dispatchOutbox(ctx: Pick<AppContext, 'db'>, limit = 200) {
  return ctx.db.system(async (tx) => {
    const events = await tx.many<OutboxRow>(
      `select * from outbox_events where dispatched_at is null order by seq limit $1 for update skip locked`,
      [limit],
    );
    let deliveries = 0;
    for (const e of events) {
      const endpoints = await tx.many<{ id: string }>(
        `select id from webhook_endpoints where tenant_id = $1 and status = 'active' and ($2 = any(event_types) or '*' = any(event_types))`,
        [e.tenant_id, e.type],
      );
      for (const ep of endpoints) {
        const d = await tx.one<{ id: string }>(
          `insert into webhook_deliveries (tenant_id, endpoint_id, event_id, event_type, payload) values ($1,$2,$3,$4,$5)
           on conflict (endpoint_id, event_id) do nothing returning id`,
          [e.tenant_id, ep.id, e.id, e.type, JSON.stringify(toDomainEvent(e))],
        );
        if (d) {
          await enqueue(tx, { tenantId: e.tenant_id, kind: WEBHOOK_JOB, payload: { delivery_id: d.id }, maxAttempts: MAX_ATTEMPTS, resource: { type: 'webhook_delivery', id: d.id } });
          deliveries++;
        }
      }
      await tx.query('update outbox_events set dispatched_at = now() where id = $1', [e.id]);
    }
    return { events: events.length, deliveries };
  });
}

/** Job handler: POSTs one delivery. Failures retry with backoff, then dead-letter. */
export function webhookHandler(ctx: AppContext, fetchImpl: typeof fetch = fetch) {
  return async ({ job }: JobContext) => {
    const id = String(job.payload.delivery_id);
    const tx = <T>(fn: Parameters<typeof ctx.db.tenant<T>>[1]) => ctx.db.tenant(job.tenant_id, fn);
    const d = await tx((t) =>
      t.one<{ id: string; event_id: string; event_type: string; payload: unknown; status: string; url: string; secret_enc: string; endpoint_id: string; endpoint_status: string }>(
        `select d.*, e.url, e.secret_enc, e.status as endpoint_status from webhook_deliveries d
           join webhook_endpoints e on e.id = d.endpoint_id where d.id = $1`,
        [id],
      ),
    );
    if (!d) throw new PermanentJobError('not_found', 'delivery not found');
    if (d.status === 'succeeded') return { skipped: true };
    if (d.endpoint_status !== 'active') {
      await tx((t) => t.query(`update webhook_deliveries set status = 'failed', last_error = 'endpoint disabled' where id = $1`, [id]));
      return { skipped: 'endpoint_disabled' };
    }
    const body = JSON.stringify(d.payload);
    const secret = openSecret(ctx.config, job.tenant_id, d.secret_enc);
    let statusCode: number | null = null;
    let error: string | null = null;
    try {
      await assertDeliverableUrl(ctx.config, d.url);
      const res = await fetchImpl(d.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'FinGraph-Webhooks/1.0',
          'fingraph-event-id': d.event_id,
          'fingraph-event-type': d.event_type,
          'fingraph-delivery-id': d.id,
          'fingraph-signature': signPayload(secret, body),
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000),
      });
      statusCode = res.status;
      if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
    } catch (err) {
      error = (err as Error).message;
    }
    const last = job.attempts >= job.max_attempts;
    const status = error ? (last ? 'dead' : 'pending') : 'succeeded';
    await tx(async (t) => {
      await t.query(
        `update webhook_deliveries set status = $2, attempts = attempts + 1, last_status_code = $3, last_error = $4,
                last_attempt_at = now(), delivered_at = case when $2 = 'succeeded' then now() else delivered_at end
          where id = $1`,
        [id, status, statusCode, error],
      );
      await t.query(
        `update webhook_endpoints set consecutive_failures = case when $2 then 0 else consecutive_failures + 1 end,
                status = case when not $2 and consecutive_failures + 1 >= $3 then 'disabled' else status end
          where id = $1`,
        [d.endpoint_id, !error, DISABLE_AFTER],
      );
    });
    if (error) throw new RetryableJobError('webhook_failed', error);
    return { status_code: statusCode };
  };
}

/** Polls the outbox continuously. */
export class OutboxDispatcher {
  private timer: NodeJS.Timeout | null = null;
  constructor(private readonly ctx: Pick<AppContext, 'db' | 'log'>) {}
  start(intervalMs = 1000) {
    if (this.timer) return;
    const loop = async () => {
      try {
        const r = await dispatchOutbox(this.ctx);
        this.timer = setTimeout(loop, r.events ? 10 : intervalMs);
      } catch (err) {
        this.ctx.log.error({ err }, 'outbox dispatch failed');
        this.timer = setTimeout(loop, intervalMs * 5);
      }
    };
    this.timer = setTimeout(loop, intervalMs);
  }
  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
