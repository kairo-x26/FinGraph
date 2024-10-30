# 0005. Evidence-first interface

Status: accepted

## Context
Reviewers distrust AI output they cannot verify (§16, "User distrust"). The engineering
priority is the chain from source document to audit evidence (§20).

## Decision
Every value that came from a document links to its page and character span. The
source viewer shows extracted text in a serif typeface with the cited span marked
in highlighter yellow, and that styling is reserved for source text. Unverified
items look unfinished (dashed, amber). AI answers always show their citations and
never sit next to decision buttons.

## Consequences
- Extraction must record exact character offsets, and chunking must preserve them.
- The design system is deliberately restrained elsewhere, so the evidence highlight
  stands out.
