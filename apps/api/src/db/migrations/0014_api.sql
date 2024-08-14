-- Idempotency keys and OAuth client-credentials API clients.

create table idempotency_keys (
  tenant_id uuid not null references tenants(id) on delete cascade,
  principal text not null,
  key text not null,
  method text not null,
  path text not null,
  request_hash text not null,
  status text not null default 'in_progress' check (status in ('in_progress', 'completed')),
  response_status int,
  response_headers jsonb,
  response_body text,
  created_at timestamptz not null default now(),
  primary key (tenant_id, principal, key)
);
create index idempotency_keys_created on idempotency_keys (created_at);
select fg_tenant_table('idempotency_keys');

create table api_clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  client_id text not null unique,
  secret_hash text not null,
  scopes text[] not null,
  created_by uuid references users(id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
select fg_tenant_table('api_clients');
