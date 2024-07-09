import { toVectorLiteral } from '../../ai/embeddings';
import type { StageDefinition } from '../ingestion/pipeline';

export interface Chunk {
  page_no: number;
  char_start: number;
  char_end: number;
  text: string;
}

interface PageLike {
  page_no: number;
  text: string;
  lines: { start: number; end: number; text: string }[];
}

/**
 * Splits pages into chunks on line boundaries (never across pages) so every chunk
 * maps back to an exact page and character range. Consecutive chunks overlap by
 * one line to keep context that straddles a boundary.
 */
export function chunkPages(pages: PageLike[], target = 700, max = 1200): Chunk[] {
  const out: Chunk[] = [];
  for (const page of pages) {
    const lines = page.lines.filter((l) => l.text.trim());
    let i = 0;
    while (i < lines.length) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1]!.end - lines[i]!.start <= max && lines[j]!.end - lines[i]!.start < target) j++;
      const start = lines[i]!.start;
      const end = lines[j]!.end;
      out.push({ page_no: page.page_no, char_start: start, char_end: end, text: page.text.slice(start, end) });
      if (j + 1 >= lines.length) break;
      // overlap by one line when the chunk spans several lines
      i = j > i ? j : j + 1;
    }
  }
  return out;
}

export const indexStage: StageDefinition = {
  stage: 'index',
  processor: 'fingraph-indexer',
  version: '1.0',
  run: async (s) => {
    const pages = await s.tx((t) =>
      t.many<PageLike>('select page_no, text, lines from document_pages where version_id = $1 order by page_no', [s.version.id]),
    );
    const chunks = chunkPages(pages);
    const vectors = chunks.length ? await s.ctx.embeddings.embed(chunks.map((c) => c.text), 'document') : [];
    await s.tx(async (t) => {
      await t.query('delete from document_chunks where version_id = $1', [s.version.id]);
      for (let i = 0; i < chunks.length; i++) {
        const c = chunks[i]!;
        await t.query(
          `insert into document_chunks (tenant_id, case_id, document_id, version_id, chunk_no, page_no, char_start, char_end, text, embedding, embedding_model)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11)`,
          [
            s.version.tenant_id,
            s.document.case_id,
            s.document.id,
            s.version.id,
            i,
            c.page_no,
            c.char_start,
            c.char_end,
            c.text,
            toVectorLiteral(vectors[i]!),
            s.ctx.embeddings.model,
          ],
        );
      }
    });
    return { chunks: chunks.length, embedding_model: s.ctx.embeddings.model };
  },
};
