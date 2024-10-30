# 0003. Tenant isolation with forced row-level security

Status: accepted

## Context
Cross-tenant leakage is a critical risk (§16), and isolation must hold in the
database, indexes, caches, tasks and storage (§12.2).

## Decision
Every tenant-owned table gets `FORCE ROW LEVEL SECURITY` with a policy on
`tenant_id = current_setting('app.tenant_id')`. Request handlers run inside
`db.tenant(id, fn)`, which sets the tenant and switches to the non-privileged
`fingraph_app` role for that transaction. Platform paths (job claiming, session
lookup, retention) use `db.system()`, which needs an explicit bypass flag.
Application queries still filter by case and document visibility.

## Consequences
- A missing `WHERE tenant_id = …` in application code cannot leak data.
- Each request runs in a transaction. That costs a little throughput and makes
  writes and audit records atomic.
- The cross-tenant sweep test (`test/security.test.ts`) calls every route with
  foreign IDs to check object-level authorization.
