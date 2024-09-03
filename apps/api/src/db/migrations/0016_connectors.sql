-- OAuth-connected document repositories (INT-03/04).
create table connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  status text not null default 'active' check (status in ('pending', 'active', 'expired', 'revoked', 'error')),
  account_label text,
  scopes text[] not null default '{}',
  access_token_enc text,
  refresh_token_enc text,
  expires_at timestamptz,
  sync_state jsonb not null default '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid references users(id),
  revoked_by uuid references users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
select fg_tenant_table('connections');
create trigger connections_updated before update on connections for each row execute function fg_touch_updated_at();

create table connector_items (
  tenant_id uuid not null references tenants(id) on delete cascade,
  connection_id uuid not null references connections(id) on delete cascade,
  remote_id text not null,
  case_id uuid not null references cases(id) on delete cascade,
  remote_modified text,
  remote_checksum text,
  document_id uuid references documents(id) on delete set null,
  imported_at timestamptz not null default now(),
  primary key (connection_id, remote_id, case_id)
);
select fg_tenant_table('connector_items');

create table connector_auth_flows (
  state text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  provider text not null,
  code_verifier text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);
