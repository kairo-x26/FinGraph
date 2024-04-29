-- Enterprise provisioning (SCIM 2.0) bearer tokens. Only hashes are stored.
create table provisioning_tokens (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  token_hash text not null unique,
  created_by uuid references users(id),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
select fg_tenant_table('provisioning_tokens');
