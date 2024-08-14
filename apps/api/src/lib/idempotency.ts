import type { FastifyInstance } from 'fastify';
import { canonicalJson, sha256Hex } from './crypto';

const KEY_RE = /^[A-Za-z0-9_.:-]{8,128}$/;
const STALE_MS = 60_000;
const TTL_HOURS = 24;

/**
 * `Idempotency-Key` support for authenticated POST requests. The first request with
 * a key runs normally and its response is stored; retries with the same key and
 * body replay that response, a different body is rejected, and a concurrent retry
 * gets 409 while the original is still running.
 */
export function registerIdempotency(app: FastifyInstance) {
  const { db } = app.ctx;

  app.addHook('preHandler', async (req, reply) => {
    const key = req.headers['idempotency-key'];
    if (req.method !== 'POST' || typeof key !== 'string' || !req.auth) return;
    if (!KEY_RE.test(key)) {
      return reply.code(400).type('application/problem+json').send({
        type: 'https://docs.fingraph.dev/errors/invalid_idempotency_key',
        title: 'Idempotency-Key must be 8-128 characters of letters, digits, "-", "_", "." or ":".',
        status: 400,
        code: 'invalid_idempotency_key',
        correlation_id: req.id,
      });
    }
    const auth = req.auth;
    const principal = auth.userId ?? `client:${auth.clientId}`;
    const path = req.routeOptions.url ?? req.url;
    const hash = sha256Hex(canonicalJson({ url: req.url, body: Buffer.isBuffer(req.body) ? sha256Hex(req.body) : (req.body ?? null) }));

    const outcome = await db.tenant(auth.tenantId, async (tx) => {
      await tx.query(`delete from idempotency_keys where created_at < now() - make_interval(hours => $1)`, [TTL_HOURS]);
      const inserted = await tx.one(
        `insert into idempotency_keys (tenant_id, principal, key, method, path, request_hash) values ($1,$2,$3,$4,$5,$6)
         on conflict do nothing returning key`,
        [auth.tenantId, principal, key, req.method, path, hash],
      );
      if (inserted) return { kind: 'new' as const };
      const row = await tx.one<{ request_hash: string; status: string; response_status: number | null; response_headers: Record<string, string> | null; response_body: string | null; created_at: Date; path: string }>(
        'select * from idempotency_keys where tenant_id = $1 and principal = $2 and key = $3 for update',
        [auth.tenantId, principal, key],
      );
      if (!row) return { kind: 'new' as const };
      if (row.request_hash !== hash || row.path !== path) return { kind: 'mismatch' as const };
      if (row.status === 'completed') return { kind: 'replay' as const, row };
      if (Date.now() - new Date(row.created_at).getTime() > STALE_MS) {
        await tx.query('update idempotency_keys set created_at = now() where tenant_id = $1 and principal = $2 and key = $3', [auth.tenantId, principal, key]);
        return { kind: 'new' as const };
      }
      return { kind: 'in_progress' as const };
    });

    if (outcome.kind === 'mismatch') {
      return reply.code(422).type('application/problem+json').send({
        type: 'https://docs.fingraph.dev/errors/idempotency_key_reused',
        title: 'This Idempotency-Key was already used with a different request.',
        status: 422,
        code: 'idempotency_key_reused',
        correlation_id: req.id,
      });
    }
    if (outcome.kind === 'in_progress') {
      return reply.code(409).type('application/problem+json').send({
        type: 'https://docs.fingraph.dev/errors/request_in_progress',
        title: 'A request with this Idempotency-Key is still being processed.',
        status: 409,
        code: 'request_in_progress',
        correlation_id: req.id,
      });
    }
    if (outcome.kind === 'replay') {
      const r = outcome.row;
      reply.header('idempotent-replayed', 'true');
      for (const [h, v] of Object.entries(r.response_headers ?? {})) reply.header(h, v);
      return reply.code(r.response_status ?? 200).send(r.response_body ?? '');
    }
    (req as { idempotency?: { key: string; principal: string } }).idempotency = { key, principal };
  });

  app.addHook('onSend', async (req, reply, payload) => {
    const idem = (req as { idempotency?: { key: string; principal: string } }).idempotency;
    if (!idem || !req.auth) return payload;
    const status = reply.statusCode;
    await db.tenant(req.auth.tenantId, (tx) =>
      status >= 500
        ? // let a retry run again after a server error
          tx.query('delete from idempotency_keys where tenant_id = $1 and principal = $2 and key = $3', [req.auth!.tenantId, idem.principal, idem.key])
        : tx.query(
            `update idempotency_keys set status = 'completed', response_status = $4, response_headers = $5, response_body = $6
              where tenant_id = $1 and principal = $2 and key = $3`,
            [
              req.auth!.tenantId,
              idem.principal,
              idem.key,
              status,
              JSON.stringify({ 'content-type': String(reply.getHeader('content-type') ?? 'application/json') }),
              typeof payload === 'string' ? payload : Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload ?? null),
            ],
          ),
    );
    return payload;
  });
}
