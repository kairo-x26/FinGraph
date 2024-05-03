-- Compliance cases, versioned required-document checklists, membership and notes.

create table checklist_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_type text not null,
  version int not null,
  items jsonb not null,
  notes text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (tenant_id, case_type, version)
);
select fg_tenant_table('checklist_templates');

create table case_counters (
  tenant_id uuid not null references tenants(id) on delete cascade,
  year int not null,
  n int not null default 0,
  primary key (tenant_id, year)
);
select fg_tenant_table('case_counters');

create table cases (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  reference text not null,
  case_type text not null,
  subject_name text not null,
  customer_ref text,
  status text not null default 'open',
  risk_level text not null default 'medium' check (risk_level in ('low', 'medium', 'high')),
  restricted boolean not null default false,
  assignee_id uuid references users(id),
  created_by uuid references users(id),
  checklist_template_id uuid references checklist_templates(id),
  due_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, reference)
);
create index cases_status on cases (tenant_id, status, created_at desc);
create index cases_assignee on cases (tenant_id, assignee_id) where closed_at is null;
create index cases_subject on cases (tenant_id, lower(subject_name));
select fg_tenant_table('cases');
create trigger cases_updated before update on cases for each row execute function fg_touch_updated_at();

create table case_members (
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null default 'reviewer' check (role in ('reviewer', 'approver', 'watcher')),
  added_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (case_id, user_id)
);
select fg_tenant_table('case_members');

create table case_notes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  author_id uuid references users(id),
  body text not null check (length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index case_notes_case on case_notes (case_id, created_at);
select fg_tenant_table('case_notes');

create table checklist_waivers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  item_key text not null,
  reason text not null,
  waived_by uuid references users(id),
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index checklist_waivers_active on checklist_waivers (case_id, item_key) where revoked_at is null;
select fg_tenant_table('checklist_waivers');

create table document_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  item_key text,
  message text not null,
  status text not null default 'open' check (status in ('open', 'fulfilled', 'cancelled')),
  requested_by uuid references users(id),
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
select fg_tenant_table('document_requests');

-- A case is visible to a user unless it is restricted, in which case only the
-- creator, the assignee and explicit members can see it.
create or replace function fg_case_visible(c cases, uid uuid) returns boolean
language sql stable as $$
  select not c.restricted
      or c.assignee_id = uid
      or c.created_by = uid
      or exists (select 1 from case_members m where m.case_id = c.id and m.user_id = uid)
$$;
