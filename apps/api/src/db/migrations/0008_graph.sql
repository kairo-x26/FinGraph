-- Knowledge graph stored relationally: entities, evidence-backed relationship
-- assertions with validity periods, entity mentions and duplicate candidates.

create table entities (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null check (kind in ('organization', 'individual')),
  display_name text not null,
  normalized_name text not null,
  jurisdiction text,
  identifiers jsonb not null default '{}'::jsonb,
  attributes jsonb not null default '{}'::jsonb,
  status text not null default 'candidate' check (status in ('candidate', 'verified', 'merged')),
  merged_into uuid references entities(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index entities_name on entities (tenant_id, kind, normalized_name) where status <> 'merged';
create index entities_ein on entities (tenant_id, (identifiers->>'ein')) where identifiers ? 'ein';
select fg_tenant_table('entities');
create trigger entities_updated before update on entities for each row execute function fg_touch_updated_at();

alter table cases add column subject_entity_id uuid references entities(id);

create table entity_mentions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity_id uuid not null references entities(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  fact_id uuid references extracted_facts(id) on delete set null,
  mention_text text not null,
  role text,
  page_no int,
  created_at timestamptz not null default now()
);
create index entity_mentions_entity on entity_mentions (entity_id);
create index entity_mentions_version on entity_mentions (version_id);
select fg_tenant_table('entity_mentions');

create table entity_relationships (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  source_entity_id uuid not null references entities(id),
  target_entity_id uuid not null references entities(id),
  relationship_type varchar(64) not null,
  ownership_pct numeric(7,4) check (ownership_pct is null or (ownership_pct >= 0 and ownership_pct <= 100)),
  role_title text,
  evidence_document_id uuid not null references documents(id) on delete cascade,
  evidence_document_version_id uuid not null references document_versions(id) on delete cascade,
  evidence_fact_ids uuid[] not null default '{}',
  evidence_page int,
  evidence_quote text,
  origin text not null default 'extraction' check (origin in ('extraction', 'manual')),
  confidence numeric(5,4),
  review_status varchar(32) not null default 'candidate'
    check (review_status in ('candidate', 'verified', 'rejected', 'conflicting')),
  valid_from timestamptz,
  valid_to timestamptz,
  reviewed_by uuid references users(id),
  reviewed_at timestamptz,
  review_comment text,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  check (source_entity_id <> target_entity_id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from)
);
create index entity_relationships_source on entity_relationships (tenant_id, source_entity_id);
create index entity_relationships_target on entity_relationships (tenant_id, target_entity_id);
create index entity_relationships_case on entity_relationships (case_id);
create index entity_relationships_version on entity_relationships (evidence_document_version_id);
select fg_tenant_table('entity_relationships');

create table relationship_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  relationship_id uuid not null references entity_relationships(id) on delete cascade,
  action text not null,
  previous_status text not null,
  new_status text not null,
  comment text,
  reviewer_id uuid references users(id),
  created_at timestamptz not null default now()
);
select fg_tenant_table('relationship_reviews');

create table entity_duplicates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  entity_a uuid not null references entities(id) on delete cascade,
  entity_b uuid not null references entities(id) on delete cascade,
  score numeric(5,4) not null,
  reasons jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'merged', 'dismissed')),
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (entity_a, entity_b)
);
select fg_tenant_table('entity_duplicates');

-- A relationship is visible when the document that evidences it is visible.
create or replace function fg_relationship_visible(r entity_relationships, uid uuid) returns boolean
language sql stable as $$
  select exists (select 1 from documents d where d.id = r.evidence_document_id and d.deleted_at is null
                 and fg_document_visible(d, uid))
$$;
