import { EVENT_SCHEMA_VERSION, type DomainEvent, type EventType } from '@fingraph/shared';
import type { Tx } from '../../db';

export interface EmitInput {
  tenantId: string;
  type: EventType;
  resource: { type: string; id: string };
  data?: Record<string, unknown>;
  correlationId?: string | null;
}

/** Writes a domain event to the outbox inside the caller's transaction. */
export async function emitEvent(tx: Tx, e: EmitInput): Promise<DomainEvent> {
  const row = await tx.one<{ id: string; occurred_at: Date }>(
    `insert into outbox_events (tenant_id, type, schema_version, resource_type, resource_id, correlation_id, data)
     values ($1, $2, $3, $4, $5, $6, $7) returning id, occurred_at`,
    [
      e.tenantId,
      e.type,
      EVENT_SCHEMA_VERSION,
      e.resource.type,
      e.resource.id,
      e.correlationId ?? null,
      JSON.stringify(e.data ?? {}),
    ],
  );
  return toDomainEvent({
    id: row!.id,
    tenant_id: e.tenantId,
    type: e.type,
    schema_version: EVENT_SCHEMA_VERSION,
    resource_type: e.resource.type,
    resource_id: e.resource.id,
    correlation_id: e.correlationId ?? null,
    data: e.data ?? {},
    occurred_at: row!.occurred_at,
  });
}

export interface OutboxRow {
  id: string;
  tenant_id: string;
  type: string;
  schema_version: string;
  resource_type: string;
  resource_id: string;
  correlation_id: string | null;
  data: Record<string, unknown>;
  occurred_at: Date;
}

export function toDomainEvent(r: OutboxRow): DomainEvent {
  return {
    id: r.id,
    type: r.type as EventType,
    tenant_id: r.tenant_id,
    occurred_at: new Date(r.occurred_at).toISOString(),
    schema_version: r.schema_version,
    correlation_id: r.correlation_id,
    resource: { type: r.resource_type, id: r.resource_id },
    data: r.data,
  };
}
