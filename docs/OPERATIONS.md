# Operations guide

## Deployment topology

| Component | Image / command | Replicas | Notes |
|---|---|---|---|
| API | `apps/api/Dockerfile`, `node dist/main.js` | 2+ | Stateless. Runs migrations on start (safe to run concurrently: each migration is one transaction and recorded once) |
| Worker | same image, `node dist/worker.js` | 2+ | Runs jobs, the maintenance scheduler and the outbox dispatcher. Scale by queue depth |
| Web | `apps/web/Dockerfile`, `node apps/web/server.js` | 2+ | Built with `API_INTERNAL_URL` pointing at the API service |
| PostgreSQL 16 + pgvector | managed (RDS, Cloud SQL, Azure Flexible Server) | primary + standby | Private network only |
| Object storage | S3-compatible bucket | — | Versioning on, public access blocked, SSE-KMS |
| ClamAV (optional) | `clamav/clamav` | 1+ | Set `MALWARE_SCANNER=clamav` |

Put the web app and the API under the same site (for example `app.example.com` with
`/api` routed to the API, or `app.` and `api.` subdomains) so the `SameSite=Lax`
session cookie works. Terminate TLS 1.2+ at the load balancer and set
`COOKIE_SECURE=true`.

`docker compose up --build` runs the whole stack locally on real Postgres. Image
builds were not exercised in the environment this project was developed in, so treat
the Dockerfiles as a starting point and verify them in your CI before production.

## Configuration reference

All configuration is via environment variables (`apps/api/src/config.ts`). The API
refuses to start in production with the default `APP_SECRET`.

| Variable | Default | Purpose |
|---|---|---|
| `NODE_ENV` | development | `production` enables production checks |
| `PORT`, `HOST` | 4000, 127.0.0.1 | Listen address (use `0.0.0.0` in containers) |
| `LOG_LEVEL` | info | pino level. Logs are JSON with `reqId` = correlation ID |
| `PUBLIC_API_URL` | http://localhost:3000/api | The API as browsers see it (OIDC and OAuth callbacks, signed upload URLs) |
| `WEB_URL` | http://localhost:3000 | Web origin (CORS, post-login redirects) |
| `DATABASE_URL` | pglite://./.data/pg | `postgres://…` in production. `pglite://memory` for throwaway runs |
| `DATABASE_POOL_SIZE` | 10 | Connections per process |
| `APP_SECRET` | dev value | 32+ chars. Derives keys for storage envelope encryption, connector tokens, IdP secrets, upload signatures, API tokens. **Rotate with care: see runbook** |
| `STORAGE_DRIVER` | local | `local` or `s3` |
| `STORAGE_LOCAL_DIR` | ./.data/objects | For `local` |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_KMS_KEY_ID` | — | For `s3`. Objects are envelope-encrypted client side *and* stored with SSE |
| `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET` | sandbox | Default IdP for organizations without their own |
| `OIDC_INTERNAL_URL` | — | Server-side base URL for the IdP when it differs from the issuer (containers) |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | 30, 12 | Defaults; organizations can override |
| `COOKIE_SECURE` | false | **true in production** |
| `PLATFORM_ADMIN_TOKEN` | — | Enables `POST /v1/organizations` for onboarding new organizations |
| `WORKER_INLINE` | true | Run jobs inside the API process. **false in production**; run `worker` separately |
| `WORKER_CONCURRENCY`, `WORKER_POLL_MS` | 2, 500 | Per worker process |
| `MAX_UPLOAD_BYTES` | 25 MB | Upload size limit |
| `MALWARE_SCANNER`, `CLAMAV_HOST`, `CLAMAV_PORT` | builtin | `clamav` adds ClamAV INSTREAM scanning |
| `OCR_PROVIDER` | none | `tesseract` OCRs image uploads (downloads language data on first use) |
| `EMBEDDING_PROVIDER`, `EMBEDDING_API_KEY` | local | `voyage` for production embeddings. Reindex after changing it (see runbook) |
| `LLM_PROVIDER` | local | `anthropic` for production answers |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_EFFORT` | —, claude-opus-5-5, medium | Claude settings |
| `RATE_LIMIT_PER_MINUTE` | 600 | Per user or API client, per API instance |
| `METRICS_TOKEN` | — | Bearer token for `/metrics`. Without it, `/metrics` is hidden in production |
| `WEBHOOK_ALLOW_PRIVATE` | on outside production | Allow webhook URLs on private networks. Keep off in production |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | — | Enables the Google Drive connector |
| `SANDBOX_URL`, `SANDBOX_PUBLIC_URL`, `SANDBOX_CONNECTOR` | — | Development sandbox connector. Never enable in production |

## Capacity and scaling

- **Ingestion** is CPU-bound in the worker (PDF parsing, OCR). Throughput grows
  roughly linearly with worker replicas × `WORKER_CONCURRENCY`. Each tenant is limited
  to 4 concurrently running jobs, so one tenant's backlog cannot starve the others.
- **Search** filters by case and document before ranking, so cost tracks the size
  of a case, not the tenant. Vector search is exact within that filtered set. Add
  an HNSW index per embedding model if searches start spanning very large document
  sets.
- **Graph traversal** is capped at depth 4, 200 nodes, 1000 edges and 2 seconds.
- **AI cost** is capped per tenant (`quotas.ai_tokens_per_day`). Every interaction
  records its tokens, which feeds the dashboard and alerts.

## Monitoring

Scrape `GET /metrics` on each API and worker instance (`Authorization: Bearer $METRICS_TOKEN`).

| Metric | Alert when |
|---|---|
| `fingraph_http_requests_total{status="5xx"}` | Error rate > 1% over 5 minutes |
| `fingraph_http_request_duration_seconds` | p95 > 2 s for reads (§5 target) |
| `fingraph_jobs_current{status="dead"}` | > 0 (investigate, see runbook) |
| `fingraph_queue_oldest_seconds` | > 300 (backlog: scale workers) |
| `fingraph_outbox_pending` | Growing for 10 minutes (dispatcher stuck) |
| `fingraph_jobs_total{outcome="retried"}` | Spike (provider or storage outage) |
| `fingraph_ai_questions_total{status="failed"}` | Any sustained rate (LLM provider issue) |

`GET /readyz` checks the database. Use it for load balancer health checks.
`GET /v1/admin/alerts` (administrators) summarizes dead jobs, backlog, undelivered
events and quota pressure, and is also shown under Administration → Governance.

Logs are JSON. Search by `reqId`; it equals the `X-Correlation-Id` response header,
which users can quote from error messages. Authorization headers, cookies and CSRF
tokens are redacted.

## Backups and disaster recovery

Targets from §5: RPO ≤ 1 hour, RTO ≤ 4 hours.

- **Database:** continuous WAL archiving / point-in-time recovery (managed Postgres
  provides it), plus daily snapshots kept 35 days. Test a restore every quarter.
- **Object storage:** bucket versioning plus cross-region replication. Objects are
  encrypted with keys derived from `APP_SECRET`, so back up the secret (in your
  secret manager) separately from the data.
- **Restore order:** database → object storage → API (migrations run) → workers →
  web. After a restore, `GET /v1/audit/verify` must report an unbroken chain.

## Runbooks

### Dead-lettered jobs
1. Administration → Governance lists jobs that gave up, with the error.
2. Transient cause (storage or provider outage): fix it, then retry the ingestion
   job from the document's processing history (`POST /v1/ingestion-jobs/{id}/retry`)
   or redeliver the webhook.
3. Permanent cause (corrupt file): ask the customer for a new copy. The document
   stays visible with its failure reason.

### Queue backlog
Check `fingraph_queue_oldest_seconds` by `kind`. For `ingest_document`, add worker
replicas. A single tenant importing in bulk is limited by the per-tenant concurrency
cap. Lower the tenant's `documents_per_day` quota if needed.

### Rotating APP_SECRET
`APP_SECRET` derives several keys. Rotating it makes existing encrypted objects,
connector tokens and tenant IdP secrets unreadable, and invalidates API access
tokens and outstanding upload URLs. Rotation therefore needs a re-encryption job:
read with the old key and write with the new one. Until that is automated, rotate
only in response to a compromise, and plan for connectors and tenant SSO secrets to
be re-entered.

### Changing the embedding model
Vectors are tagged with their model, and searches only compare vectors from the
active model. After changing `EMBEDDING_PROVIDER`, run "reprocess outdated" or
`POST /v1/cases/{id}/reprocess` for active cases. Keyword search keeps working in
the meantime.

### Retention and legal holds
The scheduler runs the retention sweep daily. It deletes cases closed longer than
the organization's `default_retention_days` that are not under legal hold. A purge
deletes stored files, pages, chunks, facts, graph claims and AI answers that cite
them, and orphaned entities. The case, a document tombstone and the audit log
remain. Preview with `GET /v1/admin/retention`.

### Suspected cross-tenant exposure
1. Capture correlation IDs from the report and pull logs and audit events.
2. Run the authorization sweep (`pnpm --filter @fingraph/api test -- test/security.test.ts`)
   against the deployed version.
3. Check that the API connects as a role that can `SET ROLE fingraph_app`, and that
   row-level security is forced: `select relname, relforcerowsecurity from pg_class where relrowsecurity`.
4. Follow your incident response plan. Audit events give who accessed what and when.

### Webhook endpoint disabled
Endpoints are disabled automatically after 50 consecutive failures. Fix the
receiver, then choose Resume under Administration → Developers and redeliver the
undelivered events.

## Release checklist

- [ ] CI green: lint, typecheck, unit/integration, AI evaluation at or above target, Postgres job, E2E
- [ ] Migrations reviewed for locking (add indexes `concurrently` in a separate migration on large tables)
- [ ] Production config: `COOKIE_SECURE=true`, `WORKER_INLINE=false`, `METRICS_TOKEN` set, sandbox disabled, `WEBHOOK_ALLOW_PRIVATE` off
- [ ] Rollback plan: images are immutable. Roll back the API/worker/web image tags. Migrations are additive; destructive changes ship one release after the code stops using them.
