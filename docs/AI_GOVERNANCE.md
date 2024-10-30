# AI governance

FinGraph uses AI to classify documents, extract fields, rank evidence and draft
answers. None of these outputs is a decision. This page records how the AI parts
work, how they are controlled and how changes are evaluated (requirements §11).
The NIST AI RMF Generative AI Profile is the voluntary reference.

## Inventory

| Capability | Implementation | Version marker | Human control |
|---|---|---|---|
| Document classification | Weighted keyword rules (`extraction/classify.ts`) | `rules-1.2` | Users can change the category. Uncertain results (< 70%) are flagged |
| Field extraction | Schema rules per category with evidence offsets (`extraction/schemas.ts`) | `schema-1.2` + per-category schema version | Critical fields must be reviewed before approval (policy) |
| OCR | Tesseract (optional) | `tesseract 7` | Confidence lowers field confidence. Unreadable pages become findings |
| Entity resolution | Identifiers, exact normalized names, and Jaro-Winkler suggestions (`graph/resolve.ts`) | — | Near matches are never merged automatically |
| Embeddings | Local feature hashing (`fingraph-hash-384-v1`) or Voyage | stored per chunk | — |
| Grounded answers | Local extractive model or Claude (`claude-opus-5-5`) | prompt `grounded-qa-2024-07-v3` | Answers show citations. Reviewers decide |

Each processing stage records its processor and version (`job_stages`). Each
extraction run records the classifier, extractor and schema version
(`extraction_runs`). Each answer records provider, model, prompt version,
retrieval parameters and source document versions (`ai_interactions`).

## Answer generation controls

1. **Authorization first.** Only chunks from documents the asker can open, in the
   current case, are retrieved. The model cannot reach anything else.
2. **Untrusted context.** The system prompt (`ai/llm.ts` `SYSTEM_PROMPT`) tells the
   model that passages are data, to cite every claim, to abstain when evidence is
   insufficient and never to make compliance decisions. Passages that look like
   instructions are removed before the call (`retrieval/rag.ts` `detectInjection`).
3. **Structured output.** Claude returns JSON matching a schema (`status`, `claims`
   with passage IDs, `missing`).
4. **Post-validation.** Claims that cite unknown passages, or whose key terms do not
   appear in the cited text, are dropped. If none remain, the answer is reported as
   insufficient evidence.
5. **Refusals.** The Claude request opts into Anthropic's server-side fallback
   (`fallbacks: "default"`). If the final response is still a refusal, FinGraph
   records an abstention flagged `model_refused`.
6. **Cost control.** Each tenant has a daily token quota. Effort is configurable
   (`ANTHROPIC_EFFORT`, default `medium`). The system prompt is cached.

## Data handling

- Only the top passages for a question (8 by default) and relationship statements
  are sent to the LLM provider, never whole case files.
- Do not enable an external provider until its data-processing terms are approved.
  Customer data must not be used to train outside models without contractual and
  legal permission.
- Purging a document redacts AI answers that cited it.

## Evaluation

`pnpm --filter @fingraph/api eval` builds a case from the synthetic fixtures, asks
the questions in `src/eval/dataset.ts` (answerable, unanswerable and adversarial)
and reports:

| Metric | Proposed pilot target |
|---|---|
| High-confidence critical field precision | ≥ 95% |
| Citation validity (citation text found in the cited version) | ≥ 98% |
| Grounded answer rate on answerable questions | ≥ 95% |
| Abstention on unanswerable questions | ≥ 90% |
| Unauthorized disclosures (cross-user, cross-tenant) | 0 |

The latest report is in [EVALUATION.md](EVALUATION.md). CI runs the evaluation on
every change and `test/eval.test.ts` fails the build below target.

These are targets on a small synthetic set. A pilot needs an access-controlled
evaluation corpus with poor scans, tables, ambiguous identities, contradictory
evidence and adversarial text, with results broken down by document category and
field criticality (§11).

## Change control

Any change to a prompt, model, provider, classifier rule or extraction schema must:

1. Bump the relevant version marker (`PROMPT_VERSION`, `CLASSIFIER_VERSION`,
   `EXTRACTOR_VERSION`, schema `version`, embedding model name).
2. Pass the evaluation with no metric below target. Include the before/after report
   in the review.
3. For extractor changes, run "reprocess outdated" after deployment. Reviewed
   facts are preserved, and only unreviewed candidates are replaced.
4. Be revertible by configuration (provider/model) or by deploying the previous
   image.

## Monitoring in production

- `fingraph_ai_questions_total{status}`: watch the abstention and failure rates.
- Reviewer feedback on answers (helpful / not helpful) is on the dashboard.
- Extraction quality on the dashboard: the share of fields accepted as extracted
  versus corrected by reviewers, broken down by period.
