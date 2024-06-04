-- Parsed pages and tables, extraction runs, extracted facts with evidence, and the
-- human review history of each fact.

create table document_pages (
  tenant_id uuid not null references tenants(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  page_no int not null,
  text text not null,
  lines jsonb not null default '[]'::jsonb,
  width numeric,
  height numeric,
  ocr boolean not null default false,
  ocr_confidence numeric(5,4),
  needs_ocr boolean not null default false,
  primary key (version_id, page_no)
);
select fg_tenant_table('document_pages');

create table document_tables (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  page_no int not null,
  header jsonb not null,
  rows jsonb not null
);
create index document_tables_version on document_tables (version_id);
select fg_tenant_table('document_tables');

create table extraction_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  job_id uuid references jobs(id) on delete set null,
  category text not null,
  classifier text not null,
  classification jsonb not null,
  extractor text not null,
  schema_version text not null,
  coverage jsonb,
  created_at timestamptz not null default now()
);
create index extraction_runs_version on extraction_runs (version_id, created_at desc);
select fg_tenant_table('extraction_runs');

create table extracted_facts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  run_id uuid not null references extraction_runs(id) on delete cascade,
  field_key text not null,
  field_label text not null,
  value_type text not null,
  value jsonb,
  value_text text,
  group_key text,
  confidence numeric(5,4) not null,
  critical boolean not null default false,
  status text not null default 'candidate'
    check (status in ('candidate', 'approved', 'corrected', 'rejected', 'superseded')),
  evidence_page int,
  evidence_start int,
  evidence_end int,
  evidence_quote text,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
create index extracted_facts_case on extracted_facts (case_id, status);
create index extracted_facts_version on extracted_facts (version_id);
select fg_tenant_table('extracted_facts');

create table fact_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  fact_id uuid not null references extracted_facts(id) on delete cascade,
  action text not null check (action in ('approve', 'correct', 'reject', 'reopen')),
  previous_status text not null,
  previous_value jsonb,
  new_value jsonb,
  comment text,
  reviewer_id uuid references users(id),
  created_at timestamptz not null default now()
);
create index fact_reviews_fact on fact_reviews (fact_id, created_at);
select fg_tenant_table('fact_reviews');
