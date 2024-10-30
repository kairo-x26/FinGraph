# 0004. Pluggable AI providers with deterministic local defaults

Status: accepted

## Context
OCR, embeddings and LLM generation are external dependencies with cost, latency,
availability and data-handling implications (§11, §16). Tests must be reproducible.

## Decision
`EmbeddingProvider`, `LlmProvider` and `OcrProvider` interfaces, chosen by
configuration:
- Local defaults: feature-hashing embeddings and an extractive answerer that only
  quotes passages, both deterministic and offline.
- Production: Voyage embeddings and Claude (`claude-opus-5-5`, structured output,
  server-side refusal fallback), plus Tesseract OCR.

Grounding is enforced outside the model. Authorization is applied before
retrieval, injected instructions are screened out, and citations are validated
after generation. Changing the model cannot weaken those guarantees.

## Consequences
- Tests and the evaluation harness run in CI without credentials.
- Answer quality in development is lower than in production. The evaluation
  harness (`pnpm --filter @fingraph/api eval`) is the gate for provider or prompt
  changes.
