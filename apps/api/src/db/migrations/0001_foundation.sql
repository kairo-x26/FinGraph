-- Foundation: extensions, the restricted application role, tenant RLS helpers,
-- tenants, users, sessions and the append-only audit log.

create extension if not exists vector;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fingraph_app') then
    create role fingraph_app nologin;
  end if;
end
$$;

-- The connecting role must be able to SET ROLE to fingraph_app.
do $$
begin
  execute format('grant fingraph_app to %I', current_user);
exception when others then
  -- superusers (e.g. embedded PGlite) can always switch roles
  null;
end
$$;

grant usage on schema public to fingraph_app;

create or replace function fg_current_tenant() returns uuid
language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid
$$;

create or replace function fg_rls_bypass() returns boolean
language sql stable as $$
  select coalesce(current_setting('app.bypass_rls', true), '') = 'on'
$$;

-- Enables forced row level security on a table with a tenant_id column and grants the
-- application role access. Every customer-owned table is registered with this.
create or replace function fg_tenant_table(tbl regclass) returns void
language plpgsql as $$
begin
  execute format('alter table %s enable row level security', tbl);
  execute format('alter table %s force row level security', tbl);
  execute format(
    'create policy tenant_isolation on %s using (tenant_id = fg_current_tenant() or fg_rls_bypass()) '
    'with check (tenant_id = fg_current_tenant() or fg_rls_bypass())', tbl);
  execute format('grant select, insert, update, delete on %s to fingraph_app', tbl);
end
$$;

create or replace function fg_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end
$$;

-- ---------------------------------------------------------------------------
-- Tenants

create table tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'),
  name text not null,
  status text not null default 'active' check (status in ('active', 'suspended')),
  settings jsonb not null default '{}'::jsonb,
  oidc_issuer text,
  oidc_client_id text,
  oidc_client_secret_enc text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table tenants enable row level security;
alter table tenants force row level security;
create policy tenant_self on tenants
  using (id = fg_current_tenant() or fg_rls_bypass())
  with check (id = fg_current_tenant() or fg_rls_bypass());
grant select, update on tenants to fingraph_app;
create trigger tenants_updated before update on tenants
  for each row execute function fg_touch_updated_at();

-- ---------------------------------------------------------------------------
-- Users

create table users (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  display_name text not null,
  roles text[] not null default '{}',
  status text not null default 'active' check (status in ('invited', 'active', 'deactivated')),
  idp_issuer text,
  idp_subject text,
  external_id text,
  last_login_at timestamptz,
  deactivated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, email)
);
create unique index users_idp_identity on users (tenant_id, idp_issuer, idp_subject)
  where idp_subject is not null;
select fg_tenant_table('users');
create trigger users_updated before update on users
  for each row execute function fg_touch_updated_at();

create table invitations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  roles text[] not null,
  token_hash text not null unique,
  invited_by uuid references users(id),
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
select fg_tenant_table('invitations');

-- ---------------------------------------------------------------------------
-- Sessions. Only a SHA-256 hash of the session token is stored.

create table sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null unique,
  csrf_token text not null,
  amr text[] not null default '{}',
  idp_session_id text,
  ip inet,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index sessions_user on sessions (user_id) where revoked_at is null;
select fg_tenant_table('sessions');

-- Pending OIDC authorization requests (state, nonce, PKCE verifier). Pre-auth, so
-- only reachable through system transactions.
create table auth_flows (
  state text primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  nonce text not null,
  code_verifier text not null,
  redirect_to text not null,
  issuer text not null,
  created_at timestamptz not null default now(),
  consumed_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Audit events: append-only and hash-chained per tenant.

create table audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id),
  seq bigint not null,
  occurred_at timestamptz not null,
  actor_type text not null check (actor_type in ('user', 'api_client', 'system')),
  actor_id text,
  action text not null,
  resource_type text not null,
  resource_id text,
  correlation_id text,
  ip inet,
  details jsonb not null default '{}'::jsonb,
  prev_hash text not null,
  hash text not null,
  unique (tenant_id, seq)
);
create index audit_events_resource on audit_events (tenant_id, resource_type, resource_id);
create index audit_events_time on audit_events (tenant_id, occurred_at desc);

alter table audit_events enable row level security;
alter table audit_events force row level security;
create policy tenant_isolation on audit_events
  using (tenant_id = fg_current_tenant() or fg_rls_bypass())
  with check (tenant_id = fg_current_tenant() or fg_rls_bypass());
grant select, insert on audit_events to fingraph_app;

create or replace function fg_audit_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'audit_events is append-only';
end
$$;
create trigger audit_events_no_update before update or delete on audit_events
  for each row execute function fg_audit_immutable();
create trigger audit_events_no_truncate before truncate on audit_events
  for each statement execute function fg_audit_immutable();
