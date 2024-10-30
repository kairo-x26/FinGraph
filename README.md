# FinGraph

Document intelligence and compliance evidence platform for KYB/KYC reviews.

FinGraph takes in financial and compliance documents and pulls out structured facts,
each linked to the page and characters it came from. It connects companies and people
in an evidence-backed relationship graph and answers analyst questions with
citations. Every decision goes through a reviewer, under a versioned policy.

```
source document → extracted fact → entity relationship → AI answer → human review → audit evidence
```

FinGraph supports human reviewers. It does not decide whether a customer is
compliant.

## What is in the box

| Area | Highlights |
|---|---|
| Intake | Signed-URL uploads, magic-byte type checks, malware scanning with quarantine, SHA-256 duplicate detection, immutable versions, batch import, OAuth repository connectors |
| Processing | Durable job queue with leases, retries and dead letters. Pipeline stages: validate, scan, parse/OCR, classify, extract, index, graph. Each stage is recorded with its processor version |
| Review | Extracted fields shown against the highlighted source page; approve, correct or reject with history; required-document checklists; discrepancy detection |
| Graph | Entities and dated relationship claims backed by evidence, entity resolution, conflict detection, beneficial-ownership roll-up, bounded multi-hop traversal |
| Search and Q&A | Hybrid keyword and vector search with authorization applied before ranking; grounded answers with validated citations, abstention and prompt-injection screening |
| Workflow | Case state machine, versioned policies, escalation, four-eyes approval, notifications, dashboards |
| Governance | Hash-chained append-only audit log, evidence packages with checksummed manifests, share links, legal holds, retention with dependency-aware purge |
| Platform | OIDC SSO with PKCE and MFA policy, SCIM provisioning, RBAC plus case/document grants, Postgres row-level security per tenant, API clients (client credentials), idempotency keys, signed webhooks, Prometheus metrics |

## Quick start (no Docker needed)

Requirements: Node 20+ and pnpm 10+.

```bash
pnpm install
pnpm --filter @fingraph/api seed     # demo organizations in an embedded Postgres (PGlite)
pnpm dev                             # sandbox IdP :4100, API :4000, web :3000
```

Open http://localhost:3000. Organization: `acme`. On the sandbox sign-in page, pick
any account. The password is `password` and the one-time code is `246810`.

| Account | Role |
|---|---|
| ana.analyst@acme.test | Compliance analyst (assigned to the Northwind case) |
| rita.risk@acme.test | Risk manager (approvals) |
| omar.onboarding@acme.test | Onboarding specialist (uploads) |
| ivy.auditor@acme.test | Internal auditor (exports) |
| alex.admin@acme.test | Platform administrator |
| dev.integrations@acme.test | Integration developer (API clients, webhooks) |
| olga@globex.test | A second organization (`globex`), for isolation checks |

With Docker you can run the full stack on real Postgres instead:
`docker compose up --build`, then `docker compose --profile demo run --rm seed`.

## Repository layout

```
apps/api        Fastify API, background worker, migrations, AI and ingestion pipeline
apps/web        Next.js web application and design system (src/ui)
apps/sandbox    Local OIDC identity provider and OAuth document repository (development only)
packages/shared Roles, permissions, domain enums, event contracts
packages/fixtures  Synthetic KYB documents used by tests, seed data and the sandbox
e2e             Playwright end-to-end and accessibility tests
docs            Guidelines, plan, design system, evaluation report, ADRs
```

## Checks

```bash
pnpm lint && pnpm typecheck
pnpm test                               # unit + API integration tests (embedded Postgres)
pnpm --filter @fingraph/api eval        # AI evaluation against the section 11 targets
pnpm e2e                                # Playwright end-to-end + accessibility
```

## Guidelines

| Document | For |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the system fits together: modules, data model, pipeline, retrieval, security boundaries |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Local setup, conventions, adding routes, migrations, pipeline stages and UI |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Configuration reference, deployment, scaling, monitoring, backups and runbooks |
| [docs/SECURITY.md](docs/SECURITY.md) | Threat model, controls, tenant isolation, identity, data protection |
| [docs/API.md](docs/API.md) | Integrating with the REST API, webhooks and connectors |
| [docs/AI_GOVERNANCE.md](docs/AI_GOVERNANCE.md) | Models, prompts, grounding, evaluation and change control for AI features |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Day-to-day use for each role |
| [docs/TRACEABILITY.md](docs/TRACEABILITY.md) | Each requirement mapped to its implementation and tests |
| [docs/DESIGN.md](docs/DESIGN.md) | Design system: tokens, type, layout principles |
| [docs/PLAN.md](docs/PLAN.md) | The staged build plan |
| [docs/EVALUATION.md](docs/EVALUATION.md) | Latest AI evaluation report |

API reference (OpenAPI): http://localhost:4000/docs while the API is running.
