-- Last run of periodic maintenance tasks per tenant; the conditional upsert makes
-- sure only one worker schedules each run.
create table scheduled_runs (
  tenant_id uuid not null references tenants(id) on delete cascade,
  task text not null,
  last_run_at timestamptz not null,
  primary key (tenant_id, task)
);
