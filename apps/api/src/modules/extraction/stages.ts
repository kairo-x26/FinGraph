import type { DocumentCategory } from '@fingraph/shared';
import { PermanentJobError } from '../jobs/errors';
import type { StageDefinition, StageState } from '../ingestion/pipeline';
import { emitEvent } from '../events/outbox';
import { classifyDocument, CLASSIFIER_VERSION, type Classification } from './classify';
import { parseDocument, type ParsedDocument } from './parse';
import { extractFacts, EXTRACTOR_VERSION, schemaVersion } from './schemas';

async function bytes(s: StageState) {
  if (!s.data) s.data = await s.ctx.storage.get(s.version.storage_key);
  return s.data;
}

/** Loads persisted pages when the parse stage was skipped on a resumed run. */
async function parsedOf(s: StageState): Promise<ParsedDocument> {
  const cached = s.scratch.parsed as ParsedDocument | undefined;
  if (cached) return cached;
  const pages = await s.tx((t) =>
    t.many('select * from document_pages where version_id = $1 order by page_no', [s.version.id]),
  );
  const tables = await s.tx((t) => t.many('select * from document_tables where version_id = $1', [s.version.id]));
  return {
    parser: 'stored',
    parser_version: '-',
    metadata: {},
    pages: pages.map((p) => ({
      page_no: p.page_no,
      text: p.text,
      lines: p.lines,
      width: p.width,
      height: p.height,
      ocr: p.ocr,
      ocr_confidence: p.ocr_confidence,
      needs_ocr: p.needs_ocr,
    })),
    tables: tables.map((t) => ({ page_no: t.page_no, header: t.header, rows: t.rows })),
  };
}

export const parseStage: StageDefinition = {
  stage: 'parse',
  processor: 'fingraph-parser',
  version: '1.0',
  resumable: true,
  run: async (s) => {
    const doc = await parseDocument(await bytes(s), s.version.mime_type, s.ctx.ocr).catch((err: Error) => {
      throw new PermanentJobError('parse_failed', `Could not read the file: ${err.message}`);
    });
    await s.tx(async (t) => {
      await t.query('delete from document_pages where version_id = $1', [s.version.id]);
      await t.query('delete from document_tables where version_id = $1', [s.version.id]);
      for (const p of doc.pages) {
        await t.query(
          `insert into document_pages (tenant_id, version_id, page_no, text, lines, width, height, ocr, ocr_confidence, needs_ocr)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [s.version.tenant_id, s.version.id, p.page_no, p.text, JSON.stringify(p.lines), p.width, p.height, p.ocr, p.ocr_confidence, p.needs_ocr],
        );
      }
      for (const tb of doc.tables) {
        await t.query('insert into document_tables (tenant_id, version_id, page_no, header, rows) values ($1,$2,$3,$4,$5)', [
          s.version.tenant_id,
          s.version.id,
          tb.page_no,
          JSON.stringify(tb.header),
          JSON.stringify(tb.rows),
        ]);
      }
      await t.query('update document_versions set page_count = $2 where id = $1', [s.version.id, doc.pages.length]);
    });
    s.scratch.parsed = doc;
    const ocrPages = doc.pages.filter((p) => p.ocr).length;
    const unreadable = doc.pages.filter((p) => p.needs_ocr).length;
    return {
      parser: doc.parser,
      parser_version: doc.parser_version,
      pages: doc.pages.length,
      tables: doc.tables.length,
      ocr_pages: ocrPages,
      unreadable_pages: unreadable,
      characters: doc.pages.reduce((n, p) => n + p.text.length, 0),
    };
  },
};

export const classifyStage: StageDefinition = {
  stage: 'classify',
  processor: 'fingraph-classifier',
  version: CLASSIFIER_VERSION,
  run: async (s) => {
    const doc = await parsedOf(s);
    const cls: Classification = classifyDocument(doc, s.version.filename);
    s.scratch.classification = cls;
    // A user's manual classification wins over the model.
    if (s.document.category_source !== 'user') {
      await s.tx((t) =>
        t.query('update documents set category = $2, category_confidence = $3, category_source = $4 where id = $1', [
          s.document.id,
          cls.category,
          cls.confidence,
          cls.method === 'model' ? 'model' : 'rules',
        ]),
      );
      s.document.category = cls.category;
    }
    return { category: cls.category, confidence: cls.confidence, method: cls.method, needs_review: cls.needs_review, scores: cls.scores };
  },
};

export const extractStage: StageDefinition = {
  stage: 'extract',
  processor: 'fingraph-extractor',
  version: EXTRACTOR_VERSION,
  run: async (s) => {
    const doc = await parsedOf(s);
    const category = (s.document.category ?? 'other') as DocumentCategory;
    const cls = (s.scratch.classification ?? { category, confidence: 1, method: 'rules' }) as Classification;
    const result = extractFacts(doc, category);

    const summary = await s.tx(async (t) => {
      // Re-delivery of the same job replaces its own run; other runs are left alone.
      await t.query('delete from extraction_runs where job_id = $1 and version_id = $2', [s.job.id, s.version.id]);
      const run = await t.one<{ id: string }>(
        `insert into extraction_runs (tenant_id, version_id, job_id, category, classifier, classification, extractor, schema_version, coverage)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [
          s.version.tenant_id,
          s.version.id,
          s.job.id,
          category,
          `${cls.method}:${CLASSIFIER_VERSION}`,
          JSON.stringify(cls),
          EXTRACTOR_VERSION,
          schemaVersion(category),
          JSON.stringify(result.coverage),
        ],
      );
      // Earlier unreviewed candidates for this document are superseded; reviewed facts stay as they are.
      await t.query(
        `update extracted_facts set status = 'superseded'
          where document_id = $1 and status = 'candidate' and run_id <> $2`,
        [s.document.id, run!.id],
      );
      const reviewed = await t.many<{ field_key: string; group_key: string | null; value: unknown }>(
        `select field_key, group_key, value from extracted_facts
          where version_id = $1 and status in ('approved', 'corrected', 'rejected')`,
        [s.version.id],
      );
      const already = new Set(reviewed.map((r) => `${r.field_key}|${r.group_key ?? ''}|${JSON.stringify(r.value)}`));
      let inserted = 0;
      for (const f of result.facts) {
        if (already.has(`${f.field_key}|${f.group_key ?? ''}|${JSON.stringify(f.value)}`)) continue;
        await t.query(
          `insert into extracted_facts (tenant_id, case_id, document_id, version_id, run_id, field_key, field_label, value_type,
                                        value, value_text, group_key, confidence, critical, evidence_page, evidence_start,
                                        evidence_end, evidence_quote)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
          [
            s.version.tenant_id,
            s.document.case_id,
            s.document.id,
            s.version.id,
            run!.id,
            f.field_key,
            f.field_label,
            f.value_type,
            JSON.stringify(f.value),
            f.value_text,
            f.group_key,
            f.confidence,
            f.critical,
            f.evidence.page_no,
            f.evidence.start,
            f.evidence.end,
            f.evidence.quote.slice(0, 2000),
          ],
        );
        inserted++;
      }
      if (result.evidence_date) {
        await t.query('update documents set evidence_date = $2 where id = $1', [s.document.id, result.evidence_date]);
      }
      if (inserted > 0) {
        await emitEvent(t, {
          tenantId: s.version.tenant_id,
          type: 'extraction.review_required',
          resource: { type: 'document', id: s.document.id },
          data: { case_id: s.document.case_id, version_id: s.version.id, facts: inserted, category },
        });
      }
      return { run_id: run!.id, inserted };
    });
    return { category, ...summary, coverage: result.coverage, evidence_date: result.evidence_date };
  },
};
