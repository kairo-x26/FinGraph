# 0002. PostgreSQL for data, queue, search, vectors and graph

Status: accepted

## Context
The MVP needs transactional data, a durable job queue, full-text search, vector
search and a relationship graph. The spec allows Postgres + pgvector, relational
graph tables and Postgres full-text search for the MVP (§10.2).

## Decision
Use one Postgres database:
- Jobs use `FOR UPDATE SKIP LOCKED` with leases. The transactional outbox handles events.
- Search uses `tsvector` with a GIN index, plus `pgvector` embeddings tagged with their model.
- The graph uses `entities` and `entity_relationships`, traversed with bounded BFS.

PGlite (Postgres compiled to WebAssembly, with pgvector) runs the same SQL in
process for tests and dependency-free local development.

## Consequences
- Enqueueing work or events commits atomically with the business change, so there
  are no dual-write gaps.
- One backup covers everything.
- At larger scale, search can move to OpenSearch and the graph to a graph store.
  The module boundaries (`retrieval`, `graph`) mark the seams.
