import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { notFound } from '../../lib/errors';
import type { DocumentRow } from '../ingestion/pipeline';

export const documentVisibleSql = (alias: string, param: string) => `fg_document_visible(${alias}, ${param}::uuid)`;

export async function getVisibleDocument(tx: Tx, auth: AuthContext, id: string, opts: { includeDeleted?: boolean } = {}) {
  const d = await tx.one<DocumentRow & { deleted_at: Date | null }>(
    `select d.* from documents d where d.id = $1 and ${documentVisibleSql('d', '$2')}
       ${opts.includeDeleted ? '' : 'and d.deleted_at is null'}`,
    [id, auth.userId],
  );
  if (!d) throw notFound('Document');
  return d;
}

/** Ids of documents in a case that the caller may read. Used to scope search and RAG. */
export async function visibleDocumentIds(tx: Tx, auth: AuthContext, caseId: string): Promise<string[]> {
  const rows = await tx.many<{ id: string }>(
    `select d.id from documents d where d.case_id = $1 and d.deleted_at is null and ${documentVisibleSql('d', '$2')}`,
    [caseId, auth.userId],
  );
  return rows.map((r) => r.id);
}
