# Development guide

## Setup

```bash
node --version      # 20 or newer (CI uses 22)
corepack enable     # provides the pnpm version pinned in package.json
pnpm install
cp apps/api/.env.example apps/api/.env   # optional, every setting has a working default
pnpm --filter @fingraph/api seed         # demo data (add -- --reset to recreate)
pnpm dev
```

`pnpm dev` starts three processes:

| Process | URL | Notes |
|---|---|---|
| Sandbox | http://localhost:4100 | OIDC provider and "Sandbox Drive" repository. Development only |
| API | http://localhost:4000 | Embedded Postgres in `apps/api/.data/pg`. Worker, scheduler and dispatcher run inline |
| Web | http://localhost:3000 | Proxies `/api/*` to the API |

Sign in with organization `acme`, password `password` and one-time code `246810`.
API reference: http://localhost:4000/docs.

To use real Postgres, run `docker compose up postgres` and set
`DATABASE_URL=postgres://fingraph:fingraph@localhost:5432/fingraph` in
`apps/api/.env`. To exercise the `pg` driver without Docker,
`tsx apps/api/scripts/pg-wire-server.ts 55432` serves an in-memory PGlite over the
Postgres wire protocol.

PGlite allows only one process per data directory. Stop `pnpm dev` before running
the seed against `.data/pg`.

## Everyday commands

| Command | What it runs |
|---|---|
| `pnpm lint` | ESLint (TypeScript and React hooks rules) |
| `pnpm typecheck` | `tsc --noEmit` in every package (the web app runs `next typegen` first) |
| `pnpm test` | Vitest in every package. API tests use an in-memory PGlite and an in-process sandbox IdP |
| `pnpm --filter @fingraph/api test -- test/graph.test.ts` | One test file |
| `pnpm --filter @fingraph/api eval` | AI evaluation; writes `docs/EVALUATION.md` and exits non-zero below target |
| `pnpm e2e` | Playwright against an isolated stack on ports 4110/4010/3010 (seeded fresh) |
| `pnpm --filter @fingraph/api migrate` | Apply migrations to `DATABASE_URL` |
| `pnpm --filter @fingraph/fixtures write ./samples` | Write the sample PDFs to disk for manual uploads |
| `pnpm build` | API bundle (tsup) and web standalone build |

## Code conventions

- **TypeScript strict** with `noUncheckedIndexedAccess`. Prefer narrow types to casts.
- **Validation at the edge with zod.** Route params, query and body are parsed by
  the `route()` helper. Handlers receive typed values.
- **SQL is written by hand** with numbered parameters. No string-built values.
  Dynamic `WHERE` clauses push to a `params` array (see `cases/routes.ts` list).
- **Errors** come from `lib/errors.ts` (`notFound`, `conflict`, `unprocessable`, …).
  Use `notFound` for objects the caller may not see, never `forbidden`. A 403
  means "you can see it but your role cannot do this".
- **Comments explain why**, not what. Keep them short.
- **Formatting:** Prettier (single quotes, 100 columns for most files).
- **Copy in the UI** is sentence case, plain verbs, no exclamation marks. Errors say
  what happened and what to do.

## Adding an API endpoint

```ts
route(app, {
  method: 'POST',
  url: '/v1/cases/:id/notes',
  summary: 'Add a case note',             // appears in OpenAPI
  tags: ['cases'],
  permission: 'case:update',              // RBAC, checked before validation
  scopes: ['cases:write'],                // only if API clients may call it
  status: 201,
  params: uuidParam,
  body: z.object({ body: z.string().trim().min(1).max(10_000) }),
  handler: async ({ params, body, auth, req, tx }) =>
    tx(async (t) => {                     // tenant-scoped transaction (RLS on)
      await getVisibleCase(t, auth, params.id);   // object-level access → 404
      const n = await t.one('insert into case_notes … returning *', [...]);
      await audit(t, req, { action: 'case.note_added', resourceType: 'case', resourceId: params.id });
      return n;
    }),
});
```

Checklist for every new endpoint:

1. Pick a permission from `packages/shared/src/rbac.ts`. Add a new one only with a
   clear role mapping.
2. Load parent objects through `getVisibleCase` or `getVisibleDocument` (or an
   equivalent visibility predicate in SQL).
3. Write an audit event for state changes, in the same transaction.
4. Emit an outbox event if integrators might care (`events/outbox.ts`, and add the
   type to `EVENT_TYPES`).
5. Add tests: the happy path, the permission denial, and a cross-tenant 404. The
   security sweep test will also call the route with another tenant's IDs and fail
   on any 2xx response.

## Adding a migration

Create `apps/api/src/db/migrations/00NN_short_name.sql`. Migrations run in one
transaction each and are never edited after merging.

```sql
create table things (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  ...
);
select fg_tenant_table('things');   -- forced RLS + grants for the app role
```

If the table holds data derived from a document, add a foreign key to the
`document_versions` row with `on delete cascade` and extend
`governance/purge.ts` so retention deletes it.

## Adding an ingestion stage

1. Implement a `StageDefinition` (`ingestion/pipeline.ts`): `stage`, `processor`,
   `version` and `run(state)`. Write outputs idempotently: delete the version's
   previous outputs, then insert.
2. Add the stage name to `INGESTION_STAGES` in `packages/shared`.
3. Insert it in order in `jobs.ts` `ingestionStages()`.
4. Throw `PermanentJobError` for inputs that will never succeed, and
   `RetryableJobError` (or any other error) for transient problems.
5. Bump `version` whenever the output changes, so reprocessing can be targeted.

## Extraction schemas

`extraction/schemas.ts` declares, for each document category, labelled fields (with
optional section scoping), date ranges and tables. Every fact carries page,
character offsets and quote. When you add a field:

- Set `critical: true` only if a reviewer must confirm it before approval.
- Add a fixture document or update an existing one in `packages/fixtures`.
- Extend `test/extraction.test.ts` and, if the field matters for precision, the
  ground truth in `src/eval/run.ts`.

## Frontend

- Pages live in `src/app/(app)/…` and are client components. Read route params with
  `useParams()`. Wrap `useSearchParams()` users in `<Suspense>` (Next 16 requires it).
- Fetch with `api()` from `lib/api.ts` inside TanStack Query hooks. Case data uses
  the `['case', id, …]` key prefix, so `useCaseMutation` can refresh everything at once.
- Use the primitives in `src/ui` (Button, Field, Sheet, Table, Badge, Dialog,
  Drawer, SourcePage, EvidenceQuote, CitationChip). Do not hard-code colors. Use the
  tokens (`text-ink-muted`, `bg-sheet`, `border-rule`, `text-register`, …) from
  `globals.css`.
- Anything quoted from a customer document is rendered with `source-text`
  (serif), and cited spans with `<mark class="evidence">`.
- Charts use `components/bar-chart.tsx` and the validated `--series-*` tokens. Run
  the palette validator if you add a series color.
- Check new screens with the accessibility test (`e2e/helpers.ts`
  `expectAccessible`). It fails on serious WCAG 2.2 AA violations.

## Testing strategy

| Layer | Where | Notes |
|---|---|---|
| Unit | `apps/api/test/extraction.test.ts`, `packages/shared` | Parsers, normalizers, classifiers, similarity |
| API integration | `apps/api/test/*.test.ts` | Real HTTP routes through `app.inject`, real SQL on PGlite, real OIDC against the sandbox |
| Security | `test/security.test.ts`, `test/identity.test.ts` | Cross-tenant sweep over every route, unauthenticated sweep, CSRF, PKCE/state/nonce/issuer |
| AI evaluation | `test/eval.test.ts`, `scripts/eval.ts` | Precision, citation validity, grounded answers, abstention, isolation |
| End to end | `e2e/*.spec.ts` | WF-01, WF-03, WF-04, WF-05, tenant isolation, accessibility |

Test helpers (`apps/api/test/helpers.ts`) provide `createTestEnv({ sandbox: true })`,
`seedTenant`, `login`/`acmeClients`, `uploadDocument` and `approveCriticalFacts`.
Background jobs do not run on their own in tests. Call `env.app.worker.drain()`.

## Commits and branches

- Small commits with an imperative subject line describing the change.
- `main` must stay green. CI runs lint, typecheck, tests, evaluation, build,
  migrations and seed on Postgres, and the E2E suite.
