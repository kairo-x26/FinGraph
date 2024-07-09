import type { EmbeddingProvider } from '../../ai/embeddings';
import { toVectorLiteral } from '../../ai/embeddings';
import type { Tx } from '../../db';
import { documentVisibleSql } from '../documents/access';

export type SearchMode = 'hybrid' | 'keyword' | 'semantic';

export interface SearchHit {
  chunk_id: string;
  case_id: string;
  case_reference?: string;
  document_id: string;
  document_title: string;
  document_category: string | null;
  version_id: string;
  page_no: number;
  char_start: number;
  char_end: number;
  text: string;
  keyword_rank: number | null;
  vector_rank: number | null;
  score: number;
  highlight: string | null;
}

export interface SearchOptions {
  query: string;
  mode: SearchMode;
  limit: number;
  /** Restrict to one case. Omit for every case the caller can see. */
  caseId?: string;
  /** Further restrict to these documents (still subject to authorization). */
  documentIds?: string[];
  /** Ranking boost for documents that evidence relevant graph relationships. */
  boostDocumentIds?: string[];
  userId: string | null;
  embeddings: EmbeddingProvider;
}

const RRF_K = 60;
const CANDIDATES = 40;

/**
 * Hybrid retrieval. The authorization filter (tenant via RLS, case and document
 * visibility via SQL) is applied inside both candidate queries, before ranking,
 * so nothing outside the caller's scope is ever scored or returned. Rankings are
 * fused with reciprocal rank fusion.
 */
export async function hybridSearch(tx: Tx, o: SearchOptions): Promise<SearchHit[]> {
  const params: unknown[] = [o.userId];
  const scope = [`d.deleted_at is null`, `c.version_id = d.current_version_id`, documentVisibleSql('d', '$1')];
  if (o.caseId) {
    params.push(o.caseId);
    scope.push(`c.case_id = $${params.length}`);
  }
  if (o.documentIds) {
    params.push(o.documentIds);
    scope.push(`c.document_id = any($${params.length})`);
  }
  const where = scope.join(' and ');
  const base = `from document_chunks c join documents d on d.id = c.document_id join cases cs on cs.id = c.case_id`;

  const keyword = new Map<string, number>();
  const vector = new Map<string, number>();
  const rows = new Map<string, Omit<SearchHit, 'keyword_rank' | 'vector_rank' | 'score'>>();
  const select = `c.id as chunk_id, c.case_id, cs.reference as case_reference, c.document_id, d.title as document_title,
                  d.category as document_category, c.version_id, c.page_no, c.char_start, c.char_end, c.text`;

  if (o.mode !== 'semantic') {
    const p = [...params, o.query];
    const q = `$${p.length}`;
    const hits = await tx.many<Omit<SearchHit, 'keyword_rank' | 'vector_rank' | 'score'>>(
      `select ${select},
              ts_headline('english', c.text, websearch_to_tsquery('english', ${q}),
                          'StartSel=<<, StopSel=>>, MaxFragments=2, MinWords=5, MaxWords=25') as highlight
         ${base}
        where ${where} and c.tsv @@ websearch_to_tsquery('english', ${q})
        order by ts_rank_cd(c.tsv, websearch_to_tsquery('english', ${q})) desc
        limit ${CANDIDATES}`,
      p,
    );
    hits.forEach((h, i) => {
      keyword.set(h.chunk_id, i + 1);
      rows.set(h.chunk_id, h);
    });
  }

  if (o.mode !== 'keyword') {
    const [qv] = await o.embeddings.embed([o.query], 'query');
    const p = [...params, toVectorLiteral(qv!), o.embeddings.model];
    const hits = await tx.many<Omit<SearchHit, 'keyword_rank' | 'vector_rank' | 'score'> & { distance: number }>(
      `select ${select}, null as highlight, c.embedding <=> $${p.length - 1}::vector as distance
         ${base}
        where ${where} and c.embedding_model = $${p.length}
        order by distance asc
        limit ${CANDIDATES}`,
      p,
    );
    hits
      .filter((h) => h.distance < 0.95)
      .forEach((h, i) => {
        vector.set(h.chunk_id, i + 1);
        if (!rows.has(h.chunk_id)) rows.set(h.chunk_id, h);
      });
  }

  const boost = new Set(o.boostDocumentIds ?? []);
  const scored: SearchHit[] = [...rows.values()].map((r) => {
    const kr = keyword.get(r.chunk_id) ?? null;
    const vr = vector.get(r.chunk_id) ?? null;
    let score = (kr ? 1 / (RRF_K + kr) : 0) + (vr ? 1 / (RRF_K + vr) : 0);
    if (boost.has(r.document_id)) score *= 1.25;
    return { ...r, keyword_rank: kr, vector_rank: vr, score: Math.round(score * 1e6) / 1e6 };
  });
  scored.sort((a, b) => b.score - a.score);

  // drop chunks that overlap an already selected chunk of the same page
  const out: SearchHit[] = [];
  for (const h of scored) {
    const overlaps = out.some(
      (x) => x.version_id === h.version_id && x.page_no === h.page_no && x.char_start < h.char_end && h.char_start < x.char_end,
    );
    if (!overlaps) out.push(h);
    if (out.length >= o.limit) break;
  }
  return out;
}
