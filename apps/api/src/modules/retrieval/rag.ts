import { PROMPT_VERSION, type GroundedAnswer, type Passage } from '../../ai/llm';
import { terms } from '../../ai/text';
import type { AppContext, AuthContext } from '../../context';
import type { Tx } from '../../db';
import { AppError } from '../../lib/errors';
import { settingsOf, type TenantRow } from '../identity/tenants';
import { caseGraph, type Edge } from '../graph/queries';
import { hybridSearch, type SearchHit } from './search';
import { metrics } from '../../lib/metrics';

const INJECTION_PATTERNS = [
  /ignore (?:all |any )?(?:previous|prior|above|earlier) instructions/i,
  /disregard (?:the )?(?:system|previous|prior) (?:prompt|instructions)/i,
  /system override/i,
  /you (?:must|should) (?:now )?(?:answer|respond|say|state) that/i,
  /reveal (?:the |your )?(?:system prompt|instructions|documents of other)/i,
  /<\/?(?:system|instructions?|passage)>/i,
];

/** Flags passages that try to instruct the model. They are withheld from generation. */
export function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

export interface Citation {
  passage_id: string;
  kind: 'document' | 'graph';
  document_id: string;
  document_title: string;
  version_id: string;
  page_no: number | null;
  char_start: number | null;
  char_end: number | null;
  excerpt: string;
  relationship_id?: string;
}

export interface AskOptions {
  caseId: string;
  question: string;
  documentIds?: string[];
  useGraph: boolean;
  maxPassages?: number;
}

const REL_TEXT: Record<string, string> = {
  OWNED_BY: 'is owned by',
  DIRECTOR_OF: 'is a director of',
  SUBSIDIARY_OF: 'is a subsidiary of',
  OFFICER_OF: 'is the control person and an officer of',
  SIGNATORY_OF: 'is a signatory of',
};

function graphPassages(edges: Edge[], names: Map<string, string>, question: string, start: number) {
  const q = new Set(terms(question));
  const relevantNames = [...names.entries()].filter(([, n]) => terms(n).some((t) => q.has(t)));
  const relationshipQuestion = ['own', 'beneficial', 'director', 'officer', 'control', 'subsidiary', 'sharehold', 'parent', 'manag', 'relationship'].some(
    (w) => [...q].some((t) => t.startsWith(w)),
  );
  if (!relationshipQuestion && !relevantNames.length) return [];
  const focus = new Set(relevantNames.map(([id]) => id));
  const chosen = edges.filter((e) => !focus.size || focus.has(e.source_entity_id) || focus.has(e.target_entity_id) || relationshipQuestion);
  return chosen.slice(0, 20).map((e, i) => {
    const pct = e.ownership_pct !== null ? ` (${Number(e.ownership_pct)}%)` : '';
    const role = e.role_title ? `, with the title ${e.role_title}` : '';
    const status = e.review_status === 'verified' ? 'verified by a reviewer' : `${e.review_status}, not yet verified`;
    const text = `${names.get(e.source_entity_id)} ${REL_TEXT[e.relationship_type] ?? e.relationship_type} ${names.get(e.target_entity_id)}${pct}${role}. Source: ${e.evidence_document_title}${e.evidence_page ? `, page ${e.evidence_page}` : ''}. Status: ${status}.`;
    return { passage: { id: `G${start + i}`, kind: 'graph' as const, title: 'Relationship graph', page: null, text }, edge: e };
  });
}

/** Drops claims without valid citations or without lexical support in the cited passages. */
export function validateAnswer(out: GroundedAnswer, passages: Passage[]) {
  const byId = new Map(passages.map((p) => [p.id, p]));
  const dropped: string[] = [];
  const claims = out.claims
    .map((c) => ({ ...c, citations: [...new Set(c.citations)].filter((id) => byId.has(id)) }))
    .filter((c) => {
      if (!c.citations.length) {
        dropped.push(c.text);
        return false;
      }
      const claimTerms = new Set(terms(c.text).filter((t) => t.length > 2));
      const cited = new Set(c.citations.flatMap((id) => terms(byId.get(id)!.text)));
      const supported = [...claimTerms].filter((t) => cited.has(t)).length;
      if (claimTerms.size && supported / claimTerms.size < 0.5) {
        dropped.push(c.text);
        return false;
      }
      return true;
    });
  const status: GroundedAnswer['status'] = out.status === 'answered' && claims.length ? 'answered' : 'insufficient_evidence';
  return { status, claims, dropped };
}

/**
 * Evidence-grounded question answering over one case (WF-04): authorize scope,
 * retrieve, optionally expand with graph relationships, generate from untrusted
 * passages, validate citations, and log provenance.
 */
export async function askQuestion(ctx: AppContext, auth: AuthContext, o: AskOptions, tx: <T>(fn: (t: Tx) => Promise<T>) => Promise<T>) {
  const started = Date.now();

  // quota check (GOV-03)
  const quota = await tx(async (t) => {
    const tenant = await t.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]);
    const used = await t.one<{ n: number }>(
      `select coalesce(sum(input_tokens + output_tokens), 0)::int as n from ai_interactions where created_at > now() - interval '1 day'`,
    );
    return { limit: settingsOf(tenant!).quotas.ai_tokens_per_day, used: used!.n };
  });
  if (quota.used >= quota.limit) {
    throw new AppError(429, 'quota_exceeded', 'The organization has used its daily AI allowance. Try again tomorrow.');
  }

  const retrieval = { mode: 'hybrid' as const, limit: o.maxPassages ?? 8, use_graph: o.useGraph, document_ids: o.documentIds ?? null };
  const { hits, graph } = await tx(async (t) => {
    const g = o.useGraph ? await caseGraph(t, o.caseId, auth.userId, { includeUnverified: true, includeHistorical: false }) : null;
    const boost = g ? [...new Set(g.edges.map((e) => e.evidence_document_id))] : [];
    const h = await hybridSearch(t, {
      query: o.question,
      mode: 'hybrid',
      limit: retrieval.limit,
      caseId: o.caseId,
      documentIds: o.documentIds,
      boostDocumentIds: boost,
      userId: auth.userId,
      embeddings: ctx.embeddings,
    });
    return { hits: h, graph: g };
  });

  const flags: string[] = [];
  const passages: Passage[] = [];
  const sources = new Map<string, { hit?: SearchHit; edge?: Edge }>();
  let n = 1;
  for (const h of hits) {
    if (detectInjection(h.text)) {
      if (!flags.includes('prompt_injection_suspected')) flags.push('prompt_injection_suspected');
      continue;
    }
    const id = `P${n++}`;
    passages.push({ id, kind: 'document', title: h.document_title, page: h.page_no, text: h.text });
    sources.set(id, { hit: h });
  }
  if (graph) {
    const names = new Map(graph.nodes.map((nd) => [nd.id, nd.display_name]));
    for (const { passage, edge } of graphPassages(graph.edges, names, o.question, 1)) {
      passages.push(passage);
      sources.set(passage.id, { edge });
    }
  }

  let result: Awaited<ReturnType<typeof ctx.llm.answer>> | null = null;
  let failure: string | null = null;
  if (passages.length) {
    try {
      result = await ctx.llm.answer(o.question, passages);
    } catch (err) {
      failure = (err as Error).message;
    }
  }

  const output: GroundedAnswer = result?.output ?? {
    status: 'insufficient_evidence',
    answer: passages.length
      ? 'The answer could not be generated.'
      : 'No authorized evidence in this case matches the question.',
    claims: [],
    missing: passages.length ? [] : ['No matching passages in the documents you can access.'],
  };
  const validated = validateAnswer(output, passages);
  if (validated.dropped.length) flags.push('unsupported_claims_removed');
  if (result?.refused) flags.push('model_refused');

  const used = new Set(validated.claims.flatMap((c) => c.citations));
  const citations: Citation[] = [...used].map((pid) => {
    const src = sources.get(pid)!;
    if (src.hit) {
      return {
        passage_id: pid,
        kind: 'document',
        document_id: src.hit.document_id,
        document_title: src.hit.document_title,
        version_id: src.hit.version_id,
        page_no: src.hit.page_no,
        char_start: src.hit.char_start,
        char_end: src.hit.char_end,
        excerpt: src.hit.text.slice(0, 600),
      };
    }
    const e = src.edge!;
    return {
      passage_id: pid,
      kind: 'graph',
      document_id: e.evidence_document_id,
      document_title: e.evidence_document_title ?? 'Document',
      version_id: e.evidence_document_version_id,
      page_no: e.evidence_page,
      char_start: null,
      char_end: null,
      excerpt: e.evidence_quote ?? '',
      relationship_id: e.id,
    };
  });

  const status = failure ? 'failed' : validated.status;
  const answerText =
    status === 'answered'
      ? validated.claims.map((c) => `${c.text} [${c.citations.join(', ')}]`).join('\n')
      : failure
        ? 'The answer could not be generated. Try again.'
        : output.status === 'answered'
          ? 'The available evidence does not support a reliable answer.'
          : output.answer;

  metrics.aiQuestions.inc({ status, provider: result?.provider ?? ctx.llm.provider });
  const row = await tx((t) =>
    t.one<{ id: string; created_at: Date }>(
      `insert into ai_interactions (tenant_id, case_id, user_id, question, status, answer, claims, citations, missing, flags,
                                    provider, model, prompt_version, retrieval, source_versions, input_tokens, output_tokens, latency_ms)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) returning id, created_at`,
      [
        auth.tenantId,
        o.caseId,
        auth.userId,
        o.question,
        status,
        answerText,
        JSON.stringify(status === 'answered' ? validated.claims : []),
        JSON.stringify(status === 'answered' ? citations : []),
        JSON.stringify(output.missing),
        JSON.stringify(flags),
        result?.provider ?? ctx.llm.provider,
        result?.model ?? ctx.llm.model,
        PROMPT_VERSION,
        JSON.stringify({ ...retrieval, passages: passages.length, embedding_model: ctx.embeddings.model, error: failure }),
        [...new Set(citations.map((c) => c.version_id))],
        result?.usage.input_tokens ?? 0,
        result?.usage.output_tokens ?? 0,
        Date.now() - started,
      ],
    ),
  );

  return {
    id: row!.id,
    status,
    question: o.question,
    answer: answerText,
    claims: status === 'answered' ? validated.claims : [],
    citations: status === 'answered' ? citations : [],
    missing: output.missing,
    flags,
    model: { provider: result?.provider ?? ctx.llm.provider, model: result?.model ?? ctx.llm.model, prompt_version: PROMPT_VERSION },
    created_at: row!.created_at,
    disclaimer: 'AI-generated summary of case evidence. Verify the cited sources; this is not a compliance decision.',
  };
}
