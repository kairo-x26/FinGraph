import type { AppContext } from '../../context';
import type { Tx } from '../../db';
import { recordAudit } from '../audit/service';
import { reconcileCase } from '../graph/build';
import { settingsOf, type TenantRow } from '../identity/tenants';

export async function activeHold(tx: Tx, caseId: string, documentId?: string | null) {
  return tx.one<{ id: string; reason: string }>(
    `select id, reason from legal_holds where case_id = $1 and released_at is null
       and (document_id is null or document_id = $2) limit 1`,
    [caseId, documentId ?? null],
  );
}

/** Removes entities that no longer have any mention, relationship or case pointing at them. */
async function dropOrphanEntities(tx: Tx) {
  const r = await tx.query(
    `delete from entities e
      where not exists (select 1 from entity_mentions m where m.entity_id = e.id)
        and not exists (select 1 from entity_relationships r where r.source_entity_id = e.id or r.target_entity_id = e.id)
        and not exists (select 1 from cases c where c.subject_entity_id = e.id)
        and not exists (select 1 from entities x where x.merged_into = e.id)`,
  );
  return r.rowCount;
}

/**
 * Deletes a document's content and every derivative: stored files, pages, tables,
 * chunks and embeddings, facts and their reviews, graph mentions and relationships,
 * and AI answers that cited it. A tombstone row stays so audit history resolves.
 * Returns the storage keys to delete once the transaction commits.
 */
export async function purgeDocumentData(tx: Tx, documentId: string): Promise<{ keys: string[]; counts: Record<string, number> }> {
  const versions = await tx.many<{ id: string; storage_key: string | null }>(
    'select id, storage_key from document_versions where document_id = $1',
    [documentId],
  );
  const ids = versions.map((v) => v.id);
  const counts: Record<string, number> = {};
  const run = async (name: string, sql: string, params: unknown[]) => {
    counts[name] = (await tx.query(sql, params)).rowCount;
  };
  await run('chunks', 'delete from document_chunks where document_id = $1', [documentId]);
  await run('pages', 'delete from document_pages where version_id = any($1)', [ids]);
  await run('tables', 'delete from document_tables where version_id = any($1)', [ids]);
  await run('relationships', 'delete from entity_relationships where evidence_document_id = $1', [documentId]);
  await run('mentions', 'delete from entity_mentions where document_id = $1', [documentId]);
  await run('facts', 'delete from extracted_facts where document_id = $1', [documentId]);
  await run('extraction_runs', 'delete from extraction_runs where version_id = any($1)', [ids]);
  await run(
    'ai_answers_redacted',
    `update ai_interactions set answer = '[redacted: a cited source was deleted]', claims = '[]', citations = '[]',
            question = '[redacted]', flags = flags || '["source_purged"]'::jsonb
      where source_versions && $1::uuid[]`,
    [ids],
  );
  await tx.query(
    `update document_versions set storage_key = null, purged_at = now(), filename = 'purged', scan_result = null, error = null
      where document_id = $1`,
    [documentId],
  );
  await tx.query(
    `update documents set title = '[purged document]', purged_at = now(), deleted_at = coalesce(deleted_at, now()), evidence_date = null
      where id = $1`,
    [documentId],
  );
  const doc = await tx.one<{ case_id: string }>('select case_id from documents where id = $1', [documentId]);
  if (doc) await reconcileCase(tx, doc.case_id);
  counts.orphan_entities = await dropOrphanEntities(tx);
  return { keys: versions.map((v) => v.storage_key).filter((k): k is string => !!k), counts };
}

/** End-of-retention purge of a whole case. The case row remains as a tombstone. */
export async function purgeCaseData(tx: Tx, caseId: string) {
  const docs = await tx.many<{ id: string }>('select id from documents where case_id = $1 and purged_at is null', [caseId]);
  const keys: string[] = [];
  const totals: Record<string, number> = { documents: docs.length };
  for (const d of docs) {
    const r = await purgeDocumentData(tx, d.id);
    keys.push(...r.keys);
    for (const [k, v] of Object.entries(r.counts)) totals[k] = (totals[k] ?? 0) + v;
  }
  const exports = await tx.many<{ storage_key: string | null }>(`select storage_key from audit_exports where case_id = $1`, [caseId]);
  keys.push(...exports.map((e) => e.storage_key).filter((k): k is string => !!k));
  await tx.query(`update audit_exports set status = 'purged', storage_key = null, manifest = null where case_id = $1`, [caseId]);
  await tx.query('delete from upload_sessions where case_id = $1', [caseId]);
  await tx.query('delete from case_notes where case_id = $1', [caseId]);
  await tx.query('delete from document_requests where case_id = $1', [caseId]);
  await tx.query('delete from ai_interactions where case_id = $1', [caseId]);
  await tx.query(`select set_config('app.purge', 'on', true)`);
  totals.decisions = (await tx.query('delete from review_decisions where case_id = $1', [caseId])).rowCount;
  await tx.query(`select set_config('app.purge', 'off', true)`);
  await tx.query(
    `update cases set subject_name = '[purged]', customer_ref = null, subject_entity_id = null, purged_at = now(),
            status = case when status in ('approved', 'rejected') then 'archived' else status end
      where id = $1`,
    [caseId],
  );
  totals.orphan_entities = (totals.orphan_entities ?? 0) + (await dropOrphanEntities(tx));
  return { keys, totals };
}

export async function deleteObjects(ctx: Pick<AppContext, 'storage' | 'log'>, keys: string[]) {
  for (const key of keys) {
    try {
      await ctx.storage.delete(key);
    } catch (err) {
      ctx.log.error({ err, key }, 'failed to delete stored object');
    }
  }
}

export const PURGE_DOCUMENT_JOB = 'purge_document';
export const RETENTION_SWEEP_JOB = 'retention_sweep';

/** Cases whose retention period has ended, excluding those under legal hold. */
export async function retentionCandidates(tx: Tx, tenantId: string) {
  const tenant = await tx.one<TenantRow>('select * from tenants where id = $1', [tenantId]);
  const days = settingsOf(tenant!).default_retention_days;
  const due = await tx.many<{ id: string; reference: string; closed_at: Date; held: boolean }>(
    `select c.id, c.reference, c.closed_at,
            exists (select 1 from legal_holds h where h.case_id = c.id and h.released_at is null) as held
       from cases c
      where c.purged_at is null and c.closed_at is not null and c.closed_at < now() - make_interval(days => $1)
      order by c.closed_at`,
    [days],
  );
  return { retention_days: days, eligible: due.filter((d) => !d.held), held: due.filter((d) => d.held) };
}

export async function runRetentionSweep(ctx: AppContext, tenantId: string) {
  const { eligible, held } = await ctx.db.tenant(tenantId, (tx) => retentionCandidates(tx, tenantId));
  let purged = 0;
  for (const c of eligible) {
    const result = await ctx.db.tenant(tenantId, async (tx) => {
      if (await activeHold(tx, c.id)) return null;
      const r = await purgeCaseData(tx, c.id);
      await recordAudit(tx, {
        tenantId,
        actor: { type: 'system', id: 'retention' },
        action: 'case.purged',
        resourceType: 'case',
        resourceId: c.id,
        details: { reference: c.reference, reason: 'retention_period_ended', ...r.totals },
      });
      return r;
    });
    if (result) {
      await deleteObjects(ctx, result.keys);
      purged++;
    }
  }
  return { purged, skipped_for_hold: held.length };
}
