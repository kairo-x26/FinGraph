-- Durable background jobs with leases (at-least-once delivery), bounded retries and
-- a dead-letter state, plus per-stage processing records for document ingestion.

create table jobs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  kind text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'dead')),
  priority int not null default 0,
  attempts int not null default 0,
  max_attempts int not null default 5,
  run_at timestamptz not null default now(),
  locked_by text,
  lease_until timestamptz,
  dedupe_key text,
  resource_type text,
  resource_id text,
  last_error jsonb,
  result jsonb,
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index jobs_ready on jobs (priority desc, run_at) where status = 'queued';
create index jobs_running on jobs (tenant_id) where status = 'running';
create index jobs_resource on jobs (tenant_id, resource_type, resource_id);
create unique index jobs_dedupe on jobs (tenant_id, dedupe_key) where dedupe_key is not null and status in ('queued', 'running');
select fg_tenant_table('jobs');

create table job_stages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  job_id uuid not null references jobs(id) on delete cascade,
  attempt int not null,
  stage text not null,
  status text not null check (status in ('running', 'succeeded', 'skipped', 'failed')),
  processor text,
  processor_version text,
  input_version_id uuid,
  error_type text,
  error_message text,
  output jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms int
);
create index job_stages_job on job_stages (job_id, started_at);
select fg_tenant_table('job_stages');
