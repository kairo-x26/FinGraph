-- Documents, immutable versions, per-document access grants and upload sessions.

create table documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  title text not null,
  category text,
  category_confidence numeric(5,4),
  category_source text check (category_source in ('model', 'rules', 'user')),
  current_version_id uuid,
  restricted boolean not null default false,
  evidence_date date,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index documents_case on documents (case_id) where deleted_at is null;
select fg_tenant_table('documents');
create trigger documents_updated before update on documents for each row execute function fg_touch_updated_at();

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  version_no int not null,
  storage_key text,
  filename text not null,
  mime_type text not null,
  size_bytes bigint not null,
  sha256 text not null,
  status text not null default 'uploaded',
  source text not null default 'upload' check (source in ('upload', 'connector', 'batch', 'api')),
  source_ref text,
  scan_result jsonb,
  page_count int,
  duplicate_of_version_id uuid references document_versions(id),
  replaced_reason text,
  uploaded_by uuid references users(id),
  error jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  purged_at timestamptz,
  unique (document_id, version_no)
);
create index document_versions_sha on document_versions (tenant_id, sha256);
select fg_tenant_table('document_versions');

alter table documents
  add constraint documents_current_version_fk foreign key (current_version_id)
  references document_versions(id) deferrable initially deferred;

create table document_grants (
  tenant_id uuid not null references tenants(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  granted_by uuid references users(id),
  created_at timestamptz not null default now(),
  primary key (document_id, user_id)
);
select fg_tenant_table('document_grants');

create table upload_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  filename text not null,
  declared_mime_type text not null,
  declared_size bigint not null,
  storage_key text not null,
  sha256 text,
  size_bytes bigint,
  detected_mime_type text,
  created_by uuid references users(id),
  expires_at timestamptz not null,
  uploaded_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
select fg_tenant_table('upload_sessions');

-- A document is readable when its case is visible and it is either unrestricted or
-- explicitly granted to the user.
create or replace function fg_document_visible(d documents, uid uuid) returns boolean
language sql stable as $$
  select exists (select 1 from cases c where c.id = d.case_id and fg_case_visible(c, uid))
     and (not d.restricted
          or d.created_by = uid
          or exists (select 1 from document_grants g where g.document_id = d.id and g.user_id = uid))
$$;
