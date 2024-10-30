# 0001. Modular monolith with asynchronous workers, in TypeScript

Status: accepted

## Context
The spec recommends a modular backend with separate document/AI workers and warns
against splitting into microservices too early (§10.1). It suggests NestJS or Spring
for the API and Python for the workers.

## Decision
One TypeScript codebase. Fastify serves the API and the same code runs the worker
process. Modules are folders with their own routes and SQL. Shared contracts
(roles, permissions, events) live in `packages/shared`, which the web app uses too.

## Consequences
- One toolchain, one test runner and shared types from database row to UI.
- The worker can be scaled separately (`node dist/worker.js`) without a second
  language runtime.
- The Python document-AI ecosystem is not available in-process. OCR and LLMs sit
  behind provider interfaces, so a Python service could be added later as another
  provider without changing the pipeline.
