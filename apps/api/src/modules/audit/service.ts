import type { FastifyRequest } from 'fastify';
import { actorOf, type Actor } from '../../context';
import type { Tx } from '../../db';
import { canonicalJson, sha256Hex } from '../../lib/crypto';

export const GENESIS_HASH = '0'.repeat(64);

export interface AuditInput {
  tenantId: string;
  actor: Actor;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  details?: Record<string, unknown>;
}

export interface AuditRow {
  id: string;
  tenant_id: string;
  seq: number;
  occurred_at: Date;
  actor_type: Actor['type'];
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  correlation_id: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  prev_hash: string;
  hash: string;
}

function hashOf(prevHash: string, e: Omit<AuditRow, 'id' | 'hash' | 'prev_hash' | 'ip'>): string {
  return sha256Hex(
    prevHash +
      canonicalJson({
        tenant_id: e.tenant_id,
        seq: e.seq,
        occurred_at: new Date(e.occurred_at).toISOString(),
        actor_type: e.actor_type,
        actor_id: e.actor_id,
        action: e.action,
        resource_type: e.resource_type,
        resource_id: e.resource_id,
        correlation_id: e.correlation_id,
        details: e.details,
      }),
  );
}

/**
 * Appends an event to the tenant's hash chain. Must run inside the same transaction
 * as the change it describes so the record and the event commit together.
 */
export async function recordAudit(tx: Tx, input: AuditInput): Promise<AuditRow> {
  // Serialize writers per tenant so sequence numbers and hashes form a single chain.
  await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 42))', [input.tenantId]);
  const last = await tx.one<{ seq: number; hash: string }>(
    'select seq, hash from audit_events where tenant_id = $1 order by seq desc limit 1',
    [input.tenantId],
  );
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const occurredAt = new Date();
  const event = {
    tenant_id: input.tenantId,
    seq,
    occurred_at: occurredAt,
    actor_type: input.actor.type,
    actor_id: input.actor.id,
    action: input.action,
    resource_type: input.resourceType,
    resource_id: input.resourceId ?? null,
    correlation_id: input.correlationId ?? null,
    details: input.details ?? {},
  };
  const hash = hashOf(prevHash, event);
  const row = await tx.one<AuditRow>(
    `insert into audit_events
       (tenant_id, seq, occurred_at, actor_type, actor_id, action, resource_type, resource_id,
        correlation_id, ip, details, prev_hash, hash)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     returning *`,
    [
      event.tenant_id,
      seq,
      occurredAt,
      event.actor_type,
      event.actor_id,
      event.action,
      event.resource_type,
      event.resource_id,
      event.correlation_id,
      input.ip ?? null,
      JSON.stringify(event.details),
      prevHash,
      hash,
    ],
  );
  return row!;
}

/** Convenience wrapper that fills actor, correlation id and IP from the request. */
export function audit(
  tx: Tx,
  req: FastifyRequest,
  input: Omit<AuditInput, 'tenantId' | 'actor' | 'correlationId' | 'ip'> & { tenantId?: string },
) {
  const tenantId = input.tenantId ?? req.auth?.tenantId;
  if (!tenantId) throw new Error('audit requires a tenant');
  return recordAudit(tx, {
    ...input,
    tenantId,
    actor: actorOf(req.auth),
    correlationId: req.id,
    ip: req.ip,
  });
}

export interface ChainVerification {
  valid: boolean;
  checked: number;
  head: string;
  broken_at_seq: number | null;
}

/** Recomputes the hash chain for a tenant and reports the first broken link. */
export async function verifyAuditChain(tx: Tx, tenantId: string): Promise<ChainVerification> {
  const rows = await tx.many<AuditRow>(
    'select * from audit_events where tenant_id = $1 order by seq asc',
    [tenantId],
  );
  let prev = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq || row.prev_hash !== prev || hashOf(prev, row) !== row.hash) {
      return { valid: false, checked: expectedSeq - 1, head: prev, broken_at_seq: row.seq };
    }
    prev = row.hash;
    expectedSeq++;
  }
  return { valid: true, checked: rows.length, head: prev, broken_at_seq: null };
}
