-- Versioned compliance policies and immutable review decisions.

create table compliance_policies (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  key text not null,
  name text not null,
  jurisdiction text not null default 'US',
  version int not null,
  case_types text[] not null,
  rules jsonb not null,
  notes text,
  status text not null default 'active' check (status in ('active', 'retired')),
  effective_from timestamptz not null default now(),
  effective_to timestamptz,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, key, version)
);
select fg_tenant_table('compliance_policies');

alter table cases add column policy_id uuid references compliance_policies(id);
alter table cases add column review_started_at timestamptz;

create table review_decisions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  kind text not null check (kind in ('start', 'recommendation', 'approval', 'escalation', 'return', 'info_request', 'reopen', 'archive')),
  outcome text,
  from_status text not null,
  to_status text not null,
  rationale text,
  decided_by uuid references users(id),
  policy_id uuid references compliance_policies(id),
  policy_version int,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index review_decisions_case on review_decisions (case_id, created_at);
select fg_tenant_table('review_decisions');

create or replace function fg_decisions_immutable() returns trigger
language plpgsql as $$
begin
  if tg_op = 'DELETE' and fg_rls_bypass() and current_setting('app.purge', true) = 'on' then
    return old;
  end if;
  raise exception 'review_decisions are immutable';
end
$$;
create trigger review_decisions_immutable before update or delete on review_decisions
  for each row execute function fg_decisions_immutable();
