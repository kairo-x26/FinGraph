# FinGraph build plan

This is the working plan for taking FinGraph from an empty repository to the full
feature set described in `FinGraph_Project_Requirements.md` (the "spec"). Each
stage ends with a green test run and one or more commits. Requirement IDs refer to
the spec (IAM-01, DOC-02, ...).

## Guiding decisions

| Topic | Decision | Why |
|---|---|---|
| Language | TypeScript everywhere (API, worker, web, dev sandbox) | One toolchain, shared contracts, one test runner |
| Repo layout | pnpm workspace monorepo | `apps/*` deployables, `packages/*` shared code |
| API | Fastify 5 + zod, modular by domain (spec §10.3) | Fast, schema-first, first-class OpenAPI |
| Worker | Separate process, Postgres-backed job queue (`FOR UPDATE SKIP LOCKED`) | Durable, at-least-once, no extra broker for the MVP; queue interface allows SQS later |
| Database | PostgreSQL 16 + pgvector + built-in FTS | Spec §10.2. Graph stored as relational nodes/edges |
| Local DB | PGlite (WASM Postgres with pgvector) in-process for tests and zero-dependency dev | No Docker needed to run or test; `docker compose` path uses real Postgres |
| Object storage | Storage interface with local-disk driver (dev) and S3 driver | Content-addressed, immutable versions |
| Auth | OIDC Authorization Code + PKCE against any IdP; bundled dev IdP for local use | IAM-01/04, MFA enforced through `amr`/`acr` claims |
| AI | Provider interfaces for embeddings, LLM and OCR. Deterministic local providers for dev/test, Anthropic Claude for generation | Tests are reproducible; production swaps providers via config |
| Web | Next.js (App Router) + Tailwind v4 with a token-based design system | Spec §10.2 |
| Graph UI | React Flow with a layered ownership layout | KG-05 |
| Tests | Vitest (unit + API integration on PGlite), Playwright (end-to-end) | |

## Stages

### Stage 0 — Foundation (Apr 2024)
- Workspace, TypeScript config, lint/format, Vitest.
- `packages/shared`: roles, permissions, enums, event names, zod contracts.
- API skeleton: config loader, structured logging, correlation IDs, error model (`application/problem+json`), health endpoints.
- Database layer: `Db` interface over `pg` and PGlite, SQL migrations runner, tenant column on every customer-owned table.
- **Test:** migrations apply on a fresh PGlite; health endpoints; error format.

### Stage 1 — Identity, tenancy and audit (Apr–May 2024)
- Tables: tenants, users, memberships, invitations, sessions.
- OIDC login with PKCE, state, nonce, issuer + signature validation (`jose`), server-side code exchange (IAM-01).
- MFA policy per tenant: reject sessions whose `amr` lacks MFA when required (IAM-04).
- Opaque session cookie (httpOnly, SameSite=Lax), CSRF double-submit token, logout, idle/absolute expiry.
- RBAC: roles from §3 mapped to permissions; case-level and document-level grants (IAM-02).
- Org admin: create org, invite, accept, deactivate (IAM-03). SCIM-style provisioning endpoint (IAM-05).
- Append-only, hash-chained audit log with DB triggers blocking UPDATE/DELETE (GOV-01).
- `apps/sandbox`: local OIDC provider (discovery, JWKS, authorize with MFA step, token, userinfo).
- **Test:** full PKCE login against sandbox, tampered state/nonce rejected, cross-tenant access denied, audit chain verification.

### Stage 2 — Cases and documents (May 2024)
- Case types with versioned required-document checklists (CASE-01/02), assignment.
- Storage drivers; upload flow: short-lived signed upload URL → upload → register (`POST /v1/documents`, 202 Accepted).
- Validation: size/type allow-list, magic bytes, SHA-256 checksum, duplicate detection, malware scanning (EICAR + ClamAV driver) with quarantine (DOC-01/02).
- Document versions and replacement history (DOC-07).
- Job queue + worker: stages, retries with backoff, dead-letter, per-tenant concurrency, job status API (DOC-03).
- **Test:** upload happy path, malware quarantine, duplicate linking, retry → dead letter, idempotent re-delivery.

### Stage 3 — Document AI (Jun 2024)
- PDF text + per-page layout extraction, OCR for images and text-less pages (DOC-04).
- Rule-based classifier with confidence; optional LLM classifier (DOC-05).
- Category extraction schemas with page/span evidence (DOC-06).
- Fact review: approve / correct / reject with history (CASE-03, US-02).
- Batch import and scheduled reprocessing that create new derivative versions (DOC-08).
- **Test:** fixture PDFs for each category, extraction precision on the fixture set, review history preserved.

### Stage 4 — Knowledge graph (Jun–Jul 2024)
- Legal entities, individuals, relationship assertions with evidence, confidence, validity dates, review status (KG-01..03).
- Assertions generated from approved/candidate facts; entity resolution with normalization + similarity, duplicate and conflict detection (KG-04).
- Bounded multi-hop traversal with depth/node limits, ultimate beneficial ownership roll-up (KG-06).
- **Test:** ownership chain fixtures, conflicts preserved, traversal limits, authorization on edges.

### Stage 5 — Search and RAG (Jul 2024)
- Chunking with page/char spans, embeddings, FTS index; ACL metadata on chunks.
- Hybrid retrieval with authorization filter applied in SQL before ranking, reciprocal-rank fusion (AI-01, AI-05).
- Grounded answering: untrusted-context prompt, citation validation, abstention (AI-02..04).
- AI interaction log with model, prompt version, retrieval params, source versions (AI-06).
- Graph-assisted retrieval (AI-07); version comparison (AI-08).
- **Test:** the US-04 Gherkin scenario, prompt-injection fixture, cross-tenant retrieval isolation.

### Stage 6 — Review workflow and governance (Aug 2024)
- Case state machine, recommendations with rationale, four-eyes approval for high risk, escalation rules from versioned policies (CASE-04, CASE-08, US-05).
- Audit evidence packages: versioned, hashed manifest, export logged (CASE-06, WF-05).
- Retention schedules, legal holds, deletion that propagates to chunks, facts, assertions and AI caches (GOV-02).
- In-app notifications (CASE-07); dashboards and tenant usage metrics, quotas (CASE-05, GOV-03); data export (GOV-04).
- **Test:** invalid transitions rejected, approval cannot be bypassed, legal hold blocks deletion, deletion propagation.

### Stage 7 — APIs and integrations (Aug–Sep 2024)
- OpenAPI docs, pagination, rate limiting, `Idempotency-Key` (INT-01).
- Event outbox → signed webhooks with retries, dedupe, dead-letter (INT-02, §9.4).
- OAuth connector framework (PKCE, encrypted tokens, refresh, revocation) with a sandbox drive provider and a Google Drive provider; resumable incremental sync (INT-03/04, WF-02, US-07).
- API clients via OAuth client credentials.
- **Test:** webhook signature + retry, connector consent/denial/revocation flows, idempotent duplicate requests.

### Stage 8 — Web application (Aug–Oct 2024)
- Design system (tokens, type, components) — see `docs/DESIGN.md`.
- Sign-in, case queue, case workspace (documents, extracted facts with source highlighting, checklist), graph explorer, evidence Q&A, review/approval, dashboards, audit log, exports, admin console (users, policies, retention, integrations, webhooks, API clients).
- **Test:** Playwright end-to-end of WF-01, WF-03, WF-04, WF-05 against seeded data; accessibility checks.

### Stage 9 — Hardening and delivery (Oct 2024)
- Seed data and sample documents, Dockerfiles, docker-compose, GitHub Actions CI.
- Security tests (tenant isolation, IDOR sweep), AI evaluation harness with the §11 metrics.
- Guidelines: architecture, development, operations, security, API usage, user guide.

## Definition of done per stage
1. Typecheck and lint pass.
2. Unit and integration tests pass on PGlite.
3. New endpoints are in the OpenAPI document and enforce tenant + object authorization.
4. New state-changing actions write audit events.

## Status

All stages are complete. Verification at the end of the build:

| Check | Result |
|---|---|
| Unit and API integration tests | 187 passing (183 API, 4 shared) |
| Cross-tenant authorization sweep | every route with a path parameter, no leaks |
| AI evaluation | all section 11 targets met on the fixture set (see EVALUATION.md) |
| End-to-end (Playwright) | WF-01, WF-03, WF-04, WF-05, tenant isolation, accessibility (WCAG 2.2 AA serious/critical): 7 passing |
| Production driver | migrations and full seed through `pg` against a Postgres wire-protocol server |

Follow-ups worth scheduling: rasterize text-less PDF pages for OCR, a shared rate-limit
store for multi-instance deployments, automated `APP_SECRET` re-encryption, and
verifying the container images in CI.
