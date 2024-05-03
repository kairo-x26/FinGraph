-- Transactional outbox for domain events (requirements 9.4). Events are written in
-- the same transaction as the change and fanned out to webhooks and notifications
-- by background workers.
create table outbox_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  seq bigserial,
  type text not null,
  schema_version text not null,
  resource_type text not null,
  resource_id text not null,
  correlation_id text,
  data jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  dispatched_at timestamptz
);
create index outbox_pending on outbox_events (seq) where dispatched_at is null;
create index outbox_tenant_time on outbox_events (tenant_id, occurred_at desc);
select fg_tenant_table('outbox_events');
grant usage on sequence outbox_events_seq_seq to fingraph_app;
