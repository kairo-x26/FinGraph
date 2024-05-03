import { z } from 'zod';
import { DOCUMENT_CATEGORIES, type CaseType } from '@fingraph/shared';
import type { Tx } from '../../db';

export const checklistItemSchema = z.object({
  key: z.string().regex(/^[a-z0-9_]{2,64}$/),
  label: z.string().min(2).max(160),
  category: z.enum(DOCUMENT_CATEGORIES),
  required: z.boolean().default(true),
  /** Evidence older than this (by document date, else upload date) no longer satisfies the item. */
  max_age_days: z.number().int().min(1).max(3650).optional(),
  guidance: z.string().max(1000).optional(),
});
export type ChecklistItem = z.infer<typeof checklistItemSchema>;

export const DEFAULT_CHECKLISTS: Record<CaseType, ChecklistItem[]> = {
  kyb_onboarding: [
    { key: 'formation', label: 'Certificate of incorporation', category: 'certificate_of_incorporation', required: true },
    { key: 'ubo', label: 'Beneficial ownership declaration', category: 'beneficial_ownership', required: true, max_age_days: 365 },
    { key: 'directors', label: 'Register of directors', category: 'director_register', required: true, max_age_days: 365 },
    { key: 'bank', label: 'Recent bank statement', category: 'bank_statement', required: true, max_age_days: 90 },
    { key: 'tax', label: 'Taxpayer identification (W-9)', category: 'tax_form', required: true },
    { key: 'structure', label: 'Ownership structure chart', category: 'ownership_chart', required: false },
  ],
  kyb_refresh: [
    { key: 'ubo', label: 'Current beneficial ownership declaration', category: 'beneficial_ownership', required: true, max_age_days: 365 },
    { key: 'directors', label: 'Current register of directors', category: 'director_register', required: true, max_age_days: 365 },
    { key: 'bank', label: 'Recent bank statement', category: 'bank_statement', required: true, max_age_days: 90 },
  ],
  kyc_individual: [
    { key: 'bank', label: 'Recent bank statement', category: 'bank_statement', required: true, max_age_days: 90 },
    { key: 'tax', label: 'Taxpayer identification', category: 'tax_form', required: true },
  ],
};

export interface TemplateRow {
  id: string;
  case_type: string;
  version: number;
  items: ChecklistItem[];
  notes: string | null;
  created_by: string | null;
  created_at: Date;
}

/** Latest template for a case type, creating version 1 from the defaults on first use. */
export async function currentTemplate(tx: Tx, tenantId: string, caseType: CaseType): Promise<TemplateRow> {
  const existing = await tx.one<TemplateRow>(
    'select * from checklist_templates where case_type = $1 order by version desc limit 1',
    [caseType],
  );
  if (existing) return existing;
  const created = await tx.one<TemplateRow>(
    `insert into checklist_templates (tenant_id, case_type, version, items, notes)
     values ($1, $2, 1, $3, 'Platform default') on conflict (tenant_id, case_type, version) do update set notes = excluded.notes
     returning *`,
    [tenantId, caseType, JSON.stringify(DEFAULT_CHECKLISTS[caseType])],
  );
  return created!;
}

export async function publishTemplate(
  tx: Tx,
  tenantId: string,
  caseType: CaseType,
  items: ChecklistItem[],
  userId: string | null,
  notes?: string,
) {
  const current = await currentTemplate(tx, tenantId, caseType);
  return (await tx.one<TemplateRow>(
    `insert into checklist_templates (tenant_id, case_type, version, items, notes, created_by)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [tenantId, caseType, current.version + 1, JSON.stringify(items), notes ?? null, userId],
  ))!;
}

export type ChecklistItemStatus = 'satisfied' | 'pending' | 'expired' | 'waived' | 'requested' | 'missing';

export interface EvaluatedItem extends ChecklistItem {
  status: ChecklistItemStatus;
  document_ids: string[];
  waiver: { reason: string; waived_by: string | null; created_at: Date } | null;
  request: { id: string; message: string; created_at: Date } | null;
}

interface DocForChecklist {
  id: string;
  category: string | null;
  version_status: string;
  evidence_date: Date | null;
  uploaded_at: Date;
}

/**
 * Evaluates the case's checklist template against its current documents, waivers
 * and open customer requests.
 */
export async function evaluateChecklist(tx: Tx, caseId: string, templateId: string | null, now = new Date()) {
  const template = templateId
    ? await tx.one<TemplateRow>('select * from checklist_templates where id = $1', [templateId])
    : undefined;
  if (!template) return { template: null, items: [] as EvaluatedItem[], complete: true };

  const docs = await tx.many<DocForChecklist>(
    `select d.id, d.category, v.status as version_status, d.evidence_date, v.created_at as uploaded_at
       from documents d join document_versions v on v.id = d.current_version_id
      where d.case_id = $1 and d.deleted_at is null`,
    [caseId],
  );
  const waivers = await tx.many<{ item_key: string; reason: string; waived_by: string | null; created_at: Date }>(
    'select item_key, reason, waived_by, created_at from checklist_waivers where case_id = $1 and revoked_at is null',
    [caseId],
  );
  const requests = await tx.many<{ id: string; item_key: string | null; message: string; created_at: Date }>(
    `select id, item_key, message, created_at from document_requests where case_id = $1 and status = 'open'`,
    [caseId],
  );

  const items: EvaluatedItem[] = template.items.map((item) => {
    const matching = docs.filter((d) => d.category === item.category);
    const usable = matching.filter((d) => d.version_status === 'processed');
    const fresh = usable.filter((d) => {
      if (!item.max_age_days) return true;
      const date = d.evidence_date ?? d.uploaded_at;
      return now.getTime() - new Date(date).getTime() <= item.max_age_days * 86_400_000;
    });
    const waiver = waivers.find((w) => w.item_key === item.key) ?? null;
    const request = requests.find((r) => r.item_key === item.key) ?? null;
    let status: ChecklistItemStatus;
    if (fresh.length) status = 'satisfied';
    else if (waiver) status = 'waived';
    else if (usable.length) status = 'expired';
    else if (matching.some((d) => ['uploaded', 'queued', 'processing'].includes(d.version_status))) status = 'pending';
    else if (request) status = 'requested';
    else status = 'missing';
    return {
      ...item,
      status,
      document_ids: (fresh.length ? fresh : matching).map((d) => d.id),
      waiver,
      request: request ? { id: request.id, message: request.message, created_at: request.created_at } : null,
    };
  });

  const complete = items.every((i) => !i.required || i.status === 'satisfied' || i.status === 'waived');
  return {
    template: { id: template.id, case_type: template.case_type, version: template.version },
    items,
    complete,
  };
}
