# FinGraph design system

## Subject, audience, job

FinGraph is a workbench for compliance analysts, risk managers and auditors who
spend whole days reviewing KYB evidence. The interface has one primary job:
**make every fact traceable to the exact words in the document that support it.**
Everything else (queues, dashboards, admin) stays quiet so that job stands out.

## Direction

The visual language borrows from the registry office, not the trading floor:
filed paper, ruled ledgers, and the yellow highlighter an analyst drags across a
certified copy. Source text is never restyled UI copy; it keeps the voice of a
document.

### Palette

| Token | Light | Dark | Use |
|---|---|---|---|
| `ink` | `#1D2B36` | `#DCE4E8` | Primary text |
| `ink-muted` | `#5A6B76` | `#93A4AE` | Secondary text, metadata |
| `paper` | `#EEF1EE` | `#0F1B22` | App background (cool, slightly green grey) |
| `sheet` | `#FFFFFF` | `#16252E` | Surfaces that hold content |
| `rule` | `#D3DAD6` | `#2A3B45` | Dividers, table rules, input borders |
| `register` | `#0B5D6B` | `#5EB7C6` | Actions, links, focus, selection |
| `marker` | `#F3DC55` | `#8A7A1F` | Evidence highlight behind cited text |
| `verified` | `#256B43` | `#62C08A` | Verified / approved / clean |
| `candidate` | `#875500` | `#E3A94A` | Proposed, waiting for a human |
| `conflict` | `#B3261E` | `#F08A80` | Conflicts, rejections, malware |

The accent (`register`, a deep registry teal) is used for interaction only.
Colour carries status, never decoration. The marker yellow appears in exactly one
role: behind source text that supports a fact or an answer.

### Type

- **Public Sans** for the interface: plain, legible, designed for government
  forms; tabular figures for percentages, dates and counts.
- **Source Serif 4** for anything quoted from a customer document: the document
  viewer, evidence excerpts, AI citations. Serif text means "this came from the
  file", sans means "this is FinGraph speaking".

Scale (rem): 0.75 / 0.8125 / 0.875 (body) / 1 / 1.25 / 1.5 / 2. Body line height
1.5 for sans, 1.6 for serif. Measure is capped at 72ch in reading panes.
Sentence case everywhere; no all-caps labels.

### Layout

```
┌────────┬──────────────────────────────────────────────────────────┐
│ rail   │ top bar: org · global search · notifications · me       │
│        ├──────────────────────────────────────────────────────────┤
│ Cases  │ KYB-24-00017  Northwind Payments LLC        [Ask] [Act]  │
│ Search │ In review · high risk · Ana Ruiz · policy v1             │
│ Graph  │ Overview  Evidence  Graph  Ask  Decisions  Activity      │
│ Dash   ├───────────────────────────┬──────────────────────────────┤
│ Audit  │ facts by document         │ source page (serif)          │
│ Admin  │  ▸ Entity name   ✓        │  … Entity name: [Northwind  │
│        │  ▸ EIN            ?        │  Payments LLC] …             │
└────────┴───────────────────────────┴──────────────────────────────┘
```

- Left rail for global areas; the case workspace is the main canvas.
- The evidence view is a **split pane**: structured facts on the left, the
  source page on the right. Selecting a fact scrolls and highlights the span.
- Lists are tables with hairline rules, not cards. Cards appear only for
  genuinely separate objects (a finding, a decision).
- Left-aligned text throughout; numbers right-aligned in tables.

### Principles

1. **Provenance first.** Any value derived from a document links to its source
   span. Unverified things look unfinished (dashed borders, amber), verified
   things look settled.
2. **The machine proposes, people decide.** AI output is labelled as such, always
   shows citations, and never sits where a decision button is.
3. **Dense but calm.** 13–14px body, generous row height, few colours on screen.
4. **Plain words.** Buttons say what happens ("Approve fact", "Send to approver").
   Errors say what went wrong and what to do next.

### Self-review against the brief

- First draft used a near-black canvas with a single acid accent for a "terminal"
  feel. That is a generic fintech default and works badly for eight-hour reading
  sessions; replaced by cool paper tones and a registry teal.
- First draft put every section in rounded cards with soft shadows. Replaced with
  ruled tables and a single elevated element (the source sheet), which is where
  the eye should go.
- Kept: the serif/sans split, because it encodes real information (document
  voice vs. product voice) rather than decorating headings.

## Components

`apps/web/src/ui` holds the primitives: `Button`, `IconButton`, `Badge`,
`StatusPill`, `Field` (`Input`, `Select`, `Textarea`), `Table`, `Tabs`, `Dialog`,
`Drawer`, `Toast`, `EmptyState`, `Skeleton`, `Menu`, `Avatar`, `Meter`, and the
signature pieces `EvidenceQuote`, `SourcePage` and `CitationChip`.

Focus is always visible (2px `register` outline, offset 2px). Motion is limited
to drawer/dialog entry and the highlight pulse when a span is selected, and is
disabled under `prefers-reduced-motion`.
