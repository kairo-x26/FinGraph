-- Audit evidence exports, controlled sharing, legal holds and purge bookkeeping.

create table audit_exports (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  version_no int not null,
  status text not null default 'queued'
    check (status in ('pending_approval', 'queued', 'building', 'ready', 'failed', 'revoked', 'purged')),
  scope jsonb not null,
  requested_by uuid references users(id),
  approved_by uuid references users(id),
  storage_key text,
  sha256 text,
  size_bytes bigint,
  manifest jsonb,
  error text,
  created_at timestamptz not null default now(),
  ready_at timestamptz,
  unique (case_id, version_no)
);
select fg_tenant_table('audit_exports');

create table export_shares (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  export_id uuid not null references audit_exports(id) on delete cascade,
  recipient text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  max_downloads int not null default 5,
  downloads int not null default 0,
  created_by uuid references users(id),
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
select fg_tenant_table('export_shares');

create table legal_holds (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  document_id uuid references documents(id) on delete cascade,
  reason text not null,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  released_by uuid references users(id),
  released_at timestamptz,
  release_reason text
);
create index legal_holds_active on legal_holds (case_id) where released_at is null;
select fg_tenant_table('legal_holds');

alter table cases add column purged_at timestamptz;
alter table documents add column purged_at timestamptz;
