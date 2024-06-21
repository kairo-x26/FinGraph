import { createHash } from 'node:crypto';
import type { Tx } from '../../db';
import { evaluateChecklist } from '../cases/checklists';
import { documentVisibleSql } from '../documents/access';
import { normalizeName } from '../extraction/normalize';
import { caseGraph, ownershipRollup } from './queries';

export type Severity = 'high' | 'medium' | 'low';

export interface Discrepancy {
  id: string;
  type:
    | 'undeclared_beneficial_owner'
    | 'ownership_conflict'
    | 'ownership_exceeds_total'
    | 'identifier_mismatch'
    | 'name_mismatch'
    | 'missing_control_person'
    | 'missing_evidence'
    | 'expired_evidence'
    | 'unreadable_pages';
  severity: Severity;
  title: string;
  detail: string;
  refs: { entities?: string[]; relationships?: string[]; facts?: string[]; documents?: string[]; checklist_items?: string[] };
}

const idOf = (type: string, refs: unknown) =>
  createHash('sha1').update(`${type}:${JSON.stringify(refs)}`).digest('hex').slice(0, 16);

function make(d: Omit<Discrepancy, 'id'>): Discrepancy {
  return { id: idOf(d.type, d.refs), ...d };
}

interface FactLite {
  id: string;
  document_id: string;
  document_title: string;
  category: string | null;
  field_key: string;
  value: unknown;
  value_text: string | null;
}

/**
 * Rule-based discrepancy detection over a case's extracted facts, ownership graph
 * and checklist. Findings point at their evidence; resolving them is a human task.
 */
export async function caseDiscrepancies(tx: Tx, caseId: string, userId: string | null): Promise<Discrepancy[]> {
  const out: Discrepancy[] = [];
  const c = (await tx.one<{ subject_name: string; checklist_template_id: string | null }>(
    'select subject_name, checklist_template_id from cases where id = $1',
    [caseId],
  ))!;

  const facts = await tx.many<FactLite>(
    `select f.id, f.document_id, d.title as document_title, d.category, f.field_key, f.value, f.value_text
       from extracted_facts f join documents d on d.id = f.document_id
      where f.case_id = $1 and f.version_id = d.current_version_id and d.deleted_at is null
        and f.status not in ('rejected', 'superseded') and ${documentVisibleSql('d', '$2')}`,
    [caseId, userId],
  );

  // 1. beneficial owners implied by the structure but not declared
  const hasDeclaration = facts.some((f) => f.category === 'beneficial_ownership');
  const rollup = await ownershipRollup(tx, caseId, userId);
  if (hasDeclaration) {
    for (const o of rollup.owners) {
      if (o.kind !== 'individual' || o.effective_pct < rollup.threshold || o.declared) continue;
      out.push(
        make({
          type: 'undeclared_beneficial_owner',
          severity: 'high',
          title: `${o.display_name} holds ${o.effective_pct}% but is not on the ownership declaration`,
          detail: `Indirect ownership through ${o.chains.map((ch) => ch.path.length).join(', ')}-step chain(s) reaches the ${rollup.threshold}% threshold.`,
          refs: { entities: [o.entity_id], relationships: [...new Set(o.chains.flatMap((ch) => ch.path.map((p) => p.relationship_id)))] },
        }),
      );
    }
  }

  // 2. conflicting ownership claims
  const graph = await caseGraph(tx, caseId, userId, { includeUnverified: true, includeHistorical: true });
  const names = new Map(graph.nodes.map((n) => [n.id, n.display_name]));
  const conflicts = graph.edges.filter((e) => e.review_status === 'conflicting');
  const seenPairs = new Set<string>();
  for (const e of conflicts) {
    const pair = `${e.source_entity_id}|${e.target_entity_id}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    const same = conflicts.filter((x) => `${x.source_entity_id}|${x.target_entity_id}` === pair);
    out.push(
      make({
        type: 'ownership_conflict',
        severity: 'high',
        title: `Documents disagree on ${names.get(e.target_entity_id)}'s stake in ${names.get(e.source_entity_id)}`,
        detail: same.map((x) => `${x.ownership_pct}% per ${x.evidence_document_title}`).join('; '),
        refs: { relationships: same.map((x) => x.id), documents: [...new Set(same.map((x) => x.evidence_document_id))] },
      }),
    );
  }

  // 3. ownership adding up to more than 100%
  const current = graph.edges.filter((e) => e.relationship_type === 'OWNED_BY' && e.ownership_pct !== null && !e.valid_to);
  const byOwned = new Map<string, Map<string, number>>();
  for (const e of current) {
    const m = byOwned.get(e.source_entity_id) ?? new Map<string, number>();
    m.set(e.target_entity_id, Math.max(m.get(e.target_entity_id) ?? 0, Number(e.ownership_pct)));
    byOwned.set(e.source_entity_id, m);
  }
  for (const [owned, owners] of byOwned) {
    const total = [...owners.values()].reduce((a, b) => a + b, 0);
    if (total > 100.5) {
      out.push(
        make({
          type: 'ownership_exceeds_total',
          severity: 'medium',
          title: `Ownership of ${names.get(owned)} adds up to ${Math.round(total * 100) / 100}%`,
          detail: 'Current ownership claims exceed 100%. One of the claims is outdated or wrong.',
          refs: { entities: [owned], relationships: current.filter((e) => e.source_entity_id === owned).map((e) => e.id) },
        }),
      );
    }
  }

  // 4. identifiers that differ between documents
  const eins = facts.filter((f) => f.field_key === 'ein' && typeof f.value === 'string');
  const distinctEins = [...new Set(eins.map((f) => f.value as string))];
  if (distinctEins.length > 1) {
    out.push(
      make({
        type: 'identifier_mismatch',
        severity: 'high',
        title: `Documents show ${distinctEins.length} different EINs`,
        detail: eins.map((f) => `${f.value} in ${f.document_title}`).join('; '),
        refs: { facts: eins.map((f) => f.id), documents: [...new Set(eins.map((f) => f.document_id))] },
      }),
    );
  }

  // 5. entity names that do not match the case subject
  const subject = normalizeName(c.subject_name);
  const nameFields = ['entity_name', 'account_holder'];
  for (const f of facts.filter((x) => nameFields.includes(x.field_key) && typeof x.value === 'string')) {
    if (normalizeName(f.value as string) !== subject) {
      out.push(
        make({
          type: 'name_mismatch',
          severity: 'medium',
          title: `"${f.value_text}" does not match the case subject`,
          detail: `${f.document_title} names "${f.value_text}"; the case is for "${c.subject_name}".`,
          refs: { facts: [f.id], documents: [f.document_id] },
        }),
      );
    }
  }

  // 6. declaration without a control person
  const declarations = [...new Set(facts.filter((f) => f.category === 'beneficial_ownership').map((f) => f.document_id))];
  for (const docId of declarations) {
    if (!facts.some((f) => f.document_id === docId && f.field_key === 'control_person_name')) {
      out.push(
        make({
          type: 'missing_control_person',
          severity: 'medium',
          title: 'Ownership declaration names no control person',
          detail: 'A control-prong individual with significant management responsibility is required.',
          refs: { documents: [docId] },
        }),
      );
    }
  }

  // 7. checklist gaps
  const checklist = await evaluateChecklist(tx, caseId, c.checklist_template_id);
  for (const item of checklist.items.filter((i) => i.required)) {
    if (item.status === 'missing' || item.status === 'requested') {
      out.push(make({ type: 'missing_evidence', severity: 'medium', title: `${item.label} is missing`, detail: item.status === 'requested' ? 'Requested from the customer.' : 'No document of this type has been received.', refs: { checklist_items: [item.key] } }));
    } else if (item.status === 'expired') {
      out.push(make({ type: 'expired_evidence', severity: 'medium', title: `${item.label} is out of date`, detail: `Evidence must be no older than ${item.max_age_days} days.`, refs: { checklist_items: [item.key], documents: item.document_ids } }));
    }
  }

  // 8. pages we could not read
  const unreadable = await tx.many<{ document_id: string; title: string; n: number }>(
    `select d.id as document_id, d.title, count(*)::int as n from document_pages p
       join documents d on d.current_version_id = p.version_id
      where d.case_id = $1 and p.needs_ocr and d.deleted_at is null and ${documentVisibleSql('d', '$2')}
      group by d.id, d.title`,
    [caseId, userId],
  );
  for (const u of unreadable) {
    out.push(make({ type: 'unreadable_pages', severity: 'low', title: `${u.n} page(s) of ${u.title} could not be read`, detail: 'Enable OCR or ask the customer for a clearer copy.', refs: { documents: [u.document_id] } }));
  }

  const rank: Record<Severity, number> = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
