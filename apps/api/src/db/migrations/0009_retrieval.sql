-- Search index (full text + vectors) over document chunks, and the AI interaction log.

create table document_chunks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid not null references cases(id) on delete cascade,
  document_id uuid not null references documents(id) on delete cascade,
  version_id uuid not null references document_versions(id) on delete cascade,
  chunk_no int not null,
  page_no int not null,
  char_start int not null,
  char_end int not null,
  text text not null,
  tsv tsvector generated always as (to_tsvector('english', text)) stored,
  -- dimensions depend on the embedding model; queries only compare vectors of the same model
  embedding vector,
  embedding_model text,
  created_at timestamptz not null default now(),
  unique (version_id, chunk_no)
);
create index document_chunks_tsv on document_chunks using gin (tsv);
create index document_chunks_document on document_chunks (document_id, version_id);
create index document_chunks_case on document_chunks (tenant_id, case_id);
select fg_tenant_table('document_chunks');

create table ai_interactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  case_id uuid references cases(id) on delete cascade,
  user_id uuid references users(id),
  kind text not null default 'question',
  question text not null,
  status text not null check (status in ('answered', 'insufficient_evidence', 'failed', 'blocked')),
  answer text,
  claims jsonb not null default '[]'::jsonb,
  citations jsonb not null default '[]'::jsonb,
  missing jsonb not null default '[]'::jsonb,
  flags jsonb not null default '[]'::jsonb,
  provider text not null,
  model text not null,
  prompt_version text not null,
  retrieval jsonb not null default '{}'::jsonb,
  source_versions uuid[] not null default '{}',
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  latency_ms int,
  feedback text check (feedback in ('helpful', 'not_helpful')),
  created_at timestamptz not null default now()
);
create index ai_interactions_case on ai_interactions (case_id, created_at desc);
create index ai_interactions_tenant_time on ai_interactions (tenant_id, created_at desc);
select fg_tenant_table('ai_interactions');
