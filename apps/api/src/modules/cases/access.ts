import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { notFound } from '../../lib/errors';

export interface CaseRow {
  id: string;
  tenant_id: string;
  reference: string;
  case_type: string;
  subject_name: string;
  customer_ref: string | null;
  status: string;
  risk_level: 'low' | 'medium' | 'high';
  restricted: boolean;
  assignee_id: string | null;
  created_by: string | null;
  checklist_template_id: string | null;
  subject_entity_id: string | null;
  due_at: Date | null;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** SQL predicate for case visibility; `$n` must be bound to the caller's user id (or null). */
export const caseVisibleSql = (alias: string, param: string) => `fg_case_visible(${alias}, ${param}::uuid)`;

/**
 * Loads a case the caller may see. Missing and invisible cases are indistinguishable
 * to the caller (404) so identifiers never leak existence.
 */
export async function getVisibleCase(tx: Tx, auth: AuthContext, caseId: string, opts: { forUpdate?: boolean } = {}) {
  const row = await tx.one<CaseRow>(
    `select c.* from cases c where c.id = $1 and ${caseVisibleSql('c', '$2')} ${opts.forUpdate ? 'for update' : ''}`,
    [caseId, auth.userId],
  );
  if (!row) throw notFound('Case');
  return row;
}

export const isClosed = (c: Pick<CaseRow, 'status'>) => ['approved', 'rejected', 'archived'].includes(c.status);
