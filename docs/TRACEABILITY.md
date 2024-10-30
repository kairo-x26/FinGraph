# Requirements traceability

Each requirement from `FinGraph_Project_Requirements.md` §4, mapped to where it is
implemented and how it is verified. Paths are relative to `apps/api` unless they
start with `apps/web`, `e2e` or `packages`.

## Authentication, authorization, organizations

| ID | Implementation | Verified by |
|---|---|---|
| IAM-01 OIDC SSO and sessions | `modules/identity/oidc.ts`, `auth-routes.ts`, `sessions.ts`; sandbox IdP `apps/sandbox` | `test/identity.test.ts` (PKCE, state, nonce, issuer, replay, CSRF, idle expiry), `e2e` sign-in in every test |
| IAM-02 tenant RBAC, case/document authorization | `packages/shared/src/rbac.ts`, `lib/http.ts`, RLS migrations, `cases/access.ts`, `documents/access.ts` | `test/security.test.ts` (route sweep), `test/cases.test.ts`, `test/documents.test.ts` |
| IAM-03 organizations, invitations, deactivation | `identity/admin-routes.ts` | `test/identity.test.ts` |
| IAM-04 MFA via IdP | `require_mfa` + `amr` check in `auth-routes.ts` | `test/identity.test.ts` "enforces the tenant MFA policy" |
| IAM-05 provisioning and access policies | `identity/scim.ts`, IP allowlist and domain rules in `tenants.ts` | `test/provisioning.test.ts` |

## Document ingestion and extraction

| ID | Implementation | Verified by |
|---|---|---|
| DOC-01 uploads | `documents/routes.ts`, `apps/web/src/components/case/evidence.tsx` | `test/documents.test.ts`, `e2e` WF-01 |
| DOC-02 validation, scanning, checksums, duplicates | `documents/filetypes.ts`, `scanner.ts`, `ingestion/pipeline.ts` | `test/documents.test.ts` (EICAR, mismatched type, duplicates) |
| DOC-03 asynchronous jobs and status | `jobs/queue.ts`, `worker.ts`, `GET /v1/ingestion-jobs/{id}` | `test/jobs.test.ts`, `test/documents.test.ts` (retry → dead letter → manual retry) |
| DOC-04 text, layout, tables, OCR | `extraction/parse.ts`, `ocr.ts` | `test/extraction.test.ts` |
| DOC-05 classification | `extraction/classify.ts` | `test/extraction.test.ts` "classifies every fixture correctly" |
| DOC-06 structured fields with sources | `extraction/schemas.ts`, `stages.ts` | `test/extraction.test.ts`, `test/review.test.ts` |
| DOC-07 versions and replacement history | `document_versions`, `replaces_document_id` | `test/documents.test.ts` "keeps version history…" |
| DOC-08 batch and scheduled reprocessing | `POST /v1/documents/batch`, `reprocess_outdated` job, scheduler | `test/review.test.ts`, `test/dashboard.test.ts` (scheduler) |

## Knowledge graph

| ID | Implementation | Verified by |
|---|---|---|
| KG-01 normalized entities | `graph/resolve.ts`, `extraction/normalize.ts` | `test/graph.test.ts` |
| KG-02 typed, evidence-backed relationships | `graph/build.ts`, `entity_relationships` | `test/graph.test.ts` |
| KG-03 confidence, source, validity, status | columns on `entity_relationships`, `reconcileCase` | `test/graph.test.ts` "closes outdated claims…" |
| KG-04 duplicates and conflicts | duplicate suggestions, `conflicting` status, discrepancies | `test/graph.test.ts` |
| KG-05 interactive graph | `apps/web/src/components/graph-view.tsx`, case Relationships tab, entity page | screenshots during development |
| KG-06 multi-hop investigation | `graph/queries.ts` `traverse`, `ownershipRollup` | `test/graph.test.ts` "traverses multiple hops with limits" |

## RAG and search

| ID | Implementation | Verified by |
|---|---|---|
| AI-01 keyword and semantic search | `retrieval/search.ts`, `/search` page | `test/rag.test.ts` |
| AI-02 answers from authorized evidence | `retrieval/rag.ts` | `test/rag.test.ts`, `e2e` WF-04 |
| AI-03 citations with page and excerpt | `Citation` with version, page, offsets | `test/rag.test.ts`, evaluation (citation validity) |
| AI-04 abstention | validation and abstention in `rag.ts` | `test/rag.test.ts`, evaluation (abstention) |
| AI-05 authorization before retrieval | visibility predicate inside candidate SQL | `test/rag.test.ts` "never returns restricted or other-tenant documents" |
| AI-06 model, prompt, retrieval, source metadata | `ai_interactions` | `test/rag.test.ts` "logs model, prompt…" |
| AI-07 graph-assisted retrieval | graph passages and boost in `rag.ts` | `test/rag.test.ts` (Thomas Reid via graph) |
| AI-08 comparison across versions and periods | `retrieval/compare.ts` | `test/rag.test.ts` "compares two document versions" |

## Cases, compliance, reporting

| ID | Implementation | Verified by |
|---|---|---|
| CASE-01 cases and reviewers | `cases/routes.ts` | `test/cases.test.ts` |
| CASE-02 checklists per case type (versioned) | `cases/checklists.ts` | `test/cases.test.ts`, `test/review.test.ts` |
| CASE-03 approve, correct, reject facts | `extraction/routes.ts` reviews | `test/review.test.ts`, `e2e` WF-03 |
| CASE-04 outcomes with rationale | `workflow/engine.ts`, `review_decisions` | `test/workflow.test.ts` |
| CASE-05 dashboards | `metrics/routes.ts`, `/dashboard` | `test/dashboard.test.ts` |
| CASE-06 versioned evidence packages | `governance/exports.ts` | `test/governance.test.ts`, `e2e` WF-05 |
| CASE-07 notifications | `notifications/*` | `test/workflow.test.ts` |
| CASE-08 versioned policies and escalation | `workflow/policies.ts`, `engine.ts` | `test/workflow.test.ts` |

## APIs, integrations, governance

| ID | Implementation | Verified by |
|---|---|---|
| INT-01 versioned REST API | `/v1`, OpenAPI at `/docs`, `lib/idempotency.ts`, API clients | `test/api.test.ts` |
| INT-02 webhooks with retries | `integrations/webhooks.ts` | `test/webhooks.test.ts` |
| INT-03 OAuth repository connection | `integrations/providers.ts`, `connections.ts`, sandbox drive | `test/connectors.test.ts` |
| INT-04 consent, refresh, expiry, revocation | `withAccessToken`, revoke route | `test/connectors.test.ts` |
| GOV-01 append-only audit | `audit/service.ts`, triggers | `test/audit.test.ts` |
| GOV-02 retention, deletion, legal holds | `governance/purge.ts`, `routes.ts` | `test/governance.test.ts` |
| GOV-03 settings, usage, alerts | tenant settings, `/v1/tenant/usage`, `/v1/admin/alerts`, `/metrics` | `test/dashboard.test.ts`, `test/foundation.test.ts` |
| GOV-04 exports and controlled sharing | evidence packages, share links | `test/governance.test.ts` |

## User stories

| Story | Covered by |
|---|---|
| US-01 upload evidence | `e2e` WF-01, `test/documents.test.ts` |
| US-02 review extracted details | `test/review.test.ts`, `e2e` WF-03 |
| US-03 ownership relationships | `test/graph.test.ts` |
| US-04 cited answers, abstention, restricted evidence | `test/rag.test.ts` "answers only from authorized evidence…" (the Gherkin scenario) |
| US-05 approval workflow | `test/workflow.test.ts`, `e2e` WF-03 |
| US-06 audit export | `test/governance.test.ts`, `e2e` WF-05 |
| US-07 revoke a provider connection | `test/connectors.test.ts` |
