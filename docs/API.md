# API integration guide

Base URL: `https://<your-host>/api` (through the web origin) or the API host directly.
The OpenAPI 3 document is at `/docs/json` and an interactive reference at `/docs`.

## Authentication

Server-to-server integrations use **OAuth 2.0 client credentials**.

1. An administrator or integration developer creates a client under Administration →
   Developers and picks its scopes. The secret is shown once.
2. Exchange the credentials for a 15-minute access token:

```bash
curl -s -X POST https://host/api/oauth/token \
  -u "$CLIENT_ID:$CLIENT_SECRET" \
  -d grant_type=client_credentials \
  -d scope="cases:write documents:write"
# {"access_token":"…","token_type":"Bearer","expires_in":900,"scope":"cases:write documents:write"}
```

3. Send `Authorization: Bearer <token>` on every request. Revoking the client stops
   its tokens immediately.

| Scope | Allows |
|---|---|
| `cases:read` | Read cases, checklists, decisions |
| `cases:write` | Create and update cases, assign reviewers |
| `documents:read` | Read and download documents, processing status, search |
| `documents:write` | Upload and register documents, batch import |
| `facts:review` | Approve, correct or reject extracted fields |
| `graph:read` | Relationships, ownership, entities |
| `rag:query` | Ask evidence questions |
| `audit:read` | Audit events and chain verification |
| `audit:export` | Evidence packages |
| `webhooks:manage` | Webhook endpoints |

API clients see only unrestricted cases. Restricted cases are visible to named
people.

## Conventions

- **IDs** are UUIDs. Knowing an ID grants nothing: anything you are not allowed to
  see returns `404`.
- **Errors** are `application/problem+json`:
  ```json
  { "type": "https://docs.fingraph.dev/errors/validation_failed", "title": "The request did not pass validation.",
    "status": 422, "code": "validation_failed", "correlation_id": "6a1…",
    "errors": [{ "path": "body.subject_name", "message": "Too small: expected string to have >=2 characters" }] }
  ```
  Branch on `code`, not on `title`. Quote `correlation_id` when you contact support.
- **Correlation:** send `X-Correlation-Id` (8–128 chars of `A-Za-z0-9._-`) to trace a
  request through logs, audit events and webhooks. Otherwise one is generated and
  returned.
- **Pagination:** list endpoints take `limit` and `cursor` and return `next_cursor`
  (`null` on the last page).
- **Idempotency:** send `Idempotency-Key` on POSTs you might retry. A retry with the
  same key and body returns the original response with `Idempotent-Replayed: true`.
  A different body returns `422 idempotency_key_reused`. A retry while the first
  request is still running returns `409 request_in_progress`. Keys last 24 hours and
  are scoped to your client.
- **Rate limits:** `429 rate_limited` with `Retry-After`. Daily quotas return
  `429 quota_exceeded`.

## Submitting documents (WF-01)

```bash
# 1. Create a case
curl -s -X POST $API/v1/cases -H "Authorization: Bearer $T" -H "Idempotency-Key: onboard-10442" \
  -H 'content-type: application/json' \
  -d '{"subject_name":"Northwind Payments LLC","customer_ref":"CUST-10442","risk_level":"medium"}'

# 2. Ask for an upload URL (valid 15 minutes, single use)
curl -s -X POST $API/v1/documents/uploads -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"case_id":"…","filename":"certificate.pdf","mime_type":"application/pdf","size_bytes":48211}'
# {"upload_id":"…","method":"PUT","upload_url":"https://host/api/v1/uploads/…?expires=…&sig=…", …}

# 3. Upload the bytes (no Authorization header; the URL is the credential)
curl -s -X PUT --data-binary @certificate.pdf -H 'content-type: application/octet-stream' "$UPLOAD_URL"

# 4. Register it; processing is asynchronous
curl -s -X POST $API/v1/documents -H "Authorization: Bearer $T" -H 'content-type: application/json' \
  -d '{"upload_id":"…"}'
# 202 {"document_id":"…","job_id":"…","status":"queued","case_id":"…","status_url":"/v1/ingestion-jobs/…"}
```

`GET /v1/ingestion-jobs/{id}` reports `status` (`queued`, `running`, `succeeded`,
`failed`, `dead`), `document_status` (`processed`, `quarantined`, `rejected`,
`failed`, …) and each stage with its processor version and duration. Uploading the
same file twice in a case returns `200` with `"duplicate": true` and the existing
`document_id`. To replace a document, register the new upload with
`replaces_document_id`. `POST /v1/documents/batch` registers up to 100 uploads at once.

Supported types: PDF, PNG, JPEG, DOCX, TXT, CSV. Up to 25 MB by default. Type is
decided by content; a mismatch with the declared type returns
`422 file_type_mismatch`.

## Reading results

| Need | Endpoint |
|---|---|
| Proposed fields with evidence | `GET /v1/documents/{id}/extractions` |
| All fields in a case | `GET /v1/cases/{id}/facts?status=approved` |
| Review a field | `POST /v1/extracted-facts/{id}/reviews` with `{"action":"approve"}` or `{"action":"correct","value":"…","comment":"…"}` |
| Relationships | `GET /v1/cases/{id}/graph`, `GET /v1/entities/{id}/relationships?depth=2` |
| Effective ownership | `GET /v1/cases/{id}/ownership?threshold=25` |
| Findings | `GET /v1/cases/{id}/discrepancies` |
| Required documents | `GET /v1/cases/{id}/checklist` |
| Evidence question | `POST /v1/cases/{id}/questions` with `{"question":"…"}` |
| Decisions | `GET /v1/cases/{id}/decisions` |
| Evidence package | `POST /v1/audit/exports` → `GET /v1/audit/exports/{id}` → `/download` |

Every fact has `evidence_page`, `evidence_start`, `evidence_end` and
`evidence_quote`. The offsets index into `GET /v1/documents/{id}/pages` text for
that version.

## Webhooks

Register an HTTPS endpoint under Administration → Developers or with
`POST /v1/webhooks` (`webhooks:manage`). Pick events from the list in §9.4:

`document.uploaded`, `document.validation_failed`, `document.processing_started`,
`document.processed`, `document.processing_failed`, `extraction.review_required`,
`extraction.approved`, `extraction.rejected`, `entity.relationship_changed`,
`case.review_assigned`, `case.review_completed`, `connection.revoked`,
`audit.export_created` (or `*`).

Each delivery is a `POST` with this body:

```json
{
  "id": "4c8a…",                       // event ID: deduplicate on this
  "type": "case.review_completed",
  "tenant_id": "…",
  "occurred_at": "2024-10-08T19:12:30.112Z",
  "schema_version": "2024-04-01",
  "correlation_id": "6a1…",
  "resource": { "type": "case", "id": "…" },
  "data": { "reference": "KYB-24-00017", "outcome": "approved", "policy_version": 2 }
}
```

Headers: `FinGraph-Event-Id`, `FinGraph-Event-Type`, `FinGraph-Delivery-Id`,
`FinGraph-Signature: t=<unix>,v1=<hex>`. Verify the signature before trusting the
body:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

export function verify(secret: string, rawBody: string, header: string, toleranceSec = 300) {
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return expected.length === parts.v1?.length && timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}
```

Respond with any 2xx within 10 seconds. Failed deliveries are retried with
exponential backoff for 8 attempts, then dead-lettered. They can be redelivered
from the console or with `POST /v1/webhooks/{id}/deliveries/{deliveryId}/redeliver`.
Delivery is at-least-once and order is not guaranteed, so make handlers
idempotent on `id`.

## Repository connectors

Administrators connect a repository (Sandbox Drive in development; Google Drive
when `GOOGLE_CLIENT_ID` is configured) with Authorization Code + PKCE and read-only
scopes. Then:

- `GET /v1/connections/{id}/files` lists files.
- `POST /v1/connections/{id}/sync` with `{"case_id":"…","file_ids":[…]}` imports in
  the background. Unchanged files are skipped and changed files become new versions.
  The job resumes from the last completed page if interrupted.
- `POST /v1/connections/{id}/revoke` revokes the tokens at the provider and stops
  imports. Documents already imported follow the retention policy.

## Enterprise provisioning (SCIM 2.0)

Create a token under Administration → People, then point your IdP at
`https://host/api/scim/v2` with `Authorization: Bearer <token>`. Supported:
`GET/POST /Users`, `GET/PATCH/DELETE /Users/{id}`, `filter=userName eq "…"`,
`active` and `roles` (values are FinGraph role IDs such as `analyst`,
`risk_manager`). Deactivating a user ends their sessions immediately.
