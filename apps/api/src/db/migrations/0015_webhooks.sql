-- Webhook endpoints and per-event deliveries.
create table webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  url text not null,
  description text,
  event_types text[] not null,
  secret_enc text not null,
  status text not null default 'active' check (status in ('active', 'disabled')),
  consecutive_failures int not null default 0,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select fg_tenant_table('webhook_endpoints');
create trigger webhook_endpoints_updated before update on webhook_endpoints for each row execute function fg_touch_updated_at();

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  endpoint_id uuid not null references webhook_endpoints(id) on delete cascade,
  event_id uuid not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed', 'dead')),
  attempts int not null default 0,
  last_status_code int,
  last_error text,
  last_attempt_at timestamptz,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
create index webhook_deliveries_endpoint on webhook_deliveries (endpoint_id, created_at desc);
select fg_tenant_table('webhook_deliveries');
