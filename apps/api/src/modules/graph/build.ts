import type { RelationshipType } from '@fingraph/shared';
import type { Tx } from '../../db';
import { emitEvent } from '../events/outbox';
import { looksLikeOrganization, normalizeName } from '../extraction/normalize';
import type { StageDefinition } from '../ingestion/pipeline';
import { resolveEntity, type EntityInput } from './resolve';

interface Fact {
  id: string;
  field_key: string;
  value: unknown;
  value_text: string | null;
  group_key: string | null;
  confidence: number;
  status: string;
  evidence_page: number | null;
  evidence_quote: string | null;
}

interface BuildContext {
  tx: Tx;
  tenantId: string;
  caseId: string;
  documentId: string;
  versionId: string;
  subjectId: string;
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v));

function groups(facts: Fact[], prefix: string) {
  const out = new Map<string, Record<string, Fact>>();
  for (const f of facts) {
    if (!f.group_key?.startsWith(`${prefix}:`)) continue;
    const g = out.get(f.group_key) ?? {};
    g[f.field_key.split('.')[1]!] = f;
    out.set(f.group_key, g);
  }
  return [...out.values()];
}

async function mention(b: BuildContext, entityId: string, f: Fact | undefined, text: string, role: string) {
  await b.tx.query(
    `insert into entity_mentions (tenant_id, entity_id, case_id, document_id, version_id, fact_id, mention_text, role, page_no)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [b.tenantId, entityId, b.caseId, b.documentId, b.versionId, f?.id ?? null, text, role, f?.evidence_page ?? null],
  );
}

async function assert(
  b: BuildContext,
  rel: {
    source: string;
    target: string;
    type: RelationshipType;
    pct?: number | null;
    title?: string | null;
    facts: (Fact | undefined)[];
    validFrom?: string | null;
  },
) {
  if (rel.source === rel.target) return null;
  const facts = rel.facts.filter((f): f is Fact => !!f);
  const anchor = facts[0];
  const confidence = facts.length ? Math.min(...facts.map((f) => Number(f.confidence))) : 0.5;
  const row = await b.tx.one<{ id: string }>(
    `insert into entity_relationships (tenant_id, case_id, source_entity_id, target_entity_id, relationship_type, ownership_pct,
                                       role_title, evidence_document_id, evidence_document_version_id, evidence_fact_ids,
                                       evidence_page, evidence_quote, confidence, valid_from)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
    [
      b.tenantId,
      b.caseId,
      rel.source,
      rel.target,
      rel.type,
      rel.pct ?? null,
      rel.title ?? null,
      b.documentId,
      b.versionId,
      facts.map((f) => f.id),
      anchor?.evidence_page ?? null,
      anchor?.evidence_quote ?? null,
      Math.round(confidence * 10000) / 10000,
      rel.validFrom ?? null,
    ],
  );
  return row!.id;
}

/** Resolves a named party; the case subject is matched by name first. */
async function party(b: BuildContext, name: string, subjectName: string, extra: Partial<EntityInput> = {}) {
  if (normalizeName(name) === normalizeName(subjectName)) return b.subjectId;
  const kind = looksLikeOrganization(name) ? 'organization' : 'individual';
  return (await resolveEntity(b.tx, b.tenantId, { kind, name, ...extra })).id;
}

/**
 * Applies temporal ordering and conflict detection to the case's ownership edges:
 * an older claim is closed (valid_to) by a newer one; claims with the same date but
 * different percentages are marked conflicting and kept for reconciliation.
 */
export async function reconcileCase(tx: Tx, caseId: string) {
  const edges = await tx.many<{
    id: string;
    source_entity_id: string;
    target_entity_id: string;
    relationship_type: string;
    ownership_pct: number | null;
    valid_from: Date | null;
    review_status: string;
  }>(
    `select r.id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.ownership_pct, r.valid_from, r.review_status
       from entity_relationships r join documents d on d.id = r.evidence_document_id
      where r.case_id = $1 and r.review_status <> 'rejected' and d.deleted_at is null
      order by r.valid_from nulls first, r.created_at`,
    [caseId],
  );
  const byPair = new Map<string, typeof edges>();
  for (const e of edges) {
    const k = `${e.source_entity_id}|${e.target_entity_id}|${e.relationship_type}`;
    byPair.set(k, [...(byPair.get(k) ?? []), e]);
  }
  for (const list of byPair.values()) {
    // reset derived state, then recompute
    for (const e of list) {
      if (e.review_status === 'conflicting') await tx.query(`update entity_relationships set review_status = 'candidate' where id = $1`, [e.id]);
      await tx.query('update entity_relationships set valid_to = null where id = $1 and origin = $2', [e.id, 'extraction']);
    }
    if (list.length < 2) continue;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      const later = list.slice(i + 1).find((x) => x.valid_from && a.valid_from && x.valid_from > a.valid_from);
      if (later) {
        await tx.query('update entity_relationships set valid_to = $2 where id = $1', [a.id, later.valid_from]);
        continue;
      }
      const sameTime = list.filter(
        (x) => x.id !== a.id && String(x.valid_from) === String(a.valid_from) && x.ownership_pct !== null && a.ownership_pct !== null &&
          Math.abs(Number(x.ownership_pct) - Number(a.ownership_pct)) > 0.5,
      );
      if (sameTime.length) {
        for (const e of [a, ...sameTime]) {
          await tx.query(
            `update entity_relationships set review_status = 'conflicting' where id = $1 and review_status = 'candidate'`,
            [e.id],
          );
        }
      }
    }
  }
}

export async function ensureSubjectEntity(tx: Tx, tenantId: string, c: { id: string; subject_name: string; subject_entity_id: string | null }) {
  if (c.subject_entity_id) return c.subject_entity_id;
  const r = await resolveEntity(tx, tenantId, { kind: 'organization', name: c.subject_name });
  await tx.query('update cases set subject_entity_id = $2 where id = $1', [c.id, r.id]);
  return r.id;
}

export const graphStage: StageDefinition = {
  stage: 'graph',
  processor: 'fingraph-graph-builder',
  version: '1.1',
  run: async (s) => {
    return s.tx(async (tx) => {
      const c = (await tx.one<{ id: string; subject_name: string; subject_entity_id: string | null }>(
        'select id, subject_name, subject_entity_id from cases where id = $1',
        [s.document.case_id],
      ))!;
      const subjectId = await ensureSubjectEntity(tx, s.version.tenant_id, c);
      const b: BuildContext = {
        tx,
        tenantId: s.version.tenant_id,
        caseId: c.id,
        documentId: s.document.id,
        versionId: s.version.id,
        subjectId,
      };

      // idempotent: replace this version's unreviewed derivatives
      await tx.query(
        `delete from entity_relationships where evidence_document_version_id = $1 and origin = 'extraction'
           and review_status in ('candidate', 'conflicting')`,
        [s.version.id],
      );
      await tx.query('delete from entity_mentions where version_id = $1', [s.version.id]);

      const facts = await tx.many<Fact>(
        `select id, field_key, value, value_text, group_key, confidence, status, evidence_page, evidence_quote
           from extracted_facts where version_id = $1 and status not in ('rejected', 'superseded')`,
        [s.version.id],
      );
      const one = (k: string) => facts.find((f) => f.field_key === k && !f.group_key);
      const created: string[] = [];
      const push = (id: string | null) => id && created.push(id);

      switch (s.document.category) {
        case 'certificate_of_incorporation':
        case 'tax_form': {
          const name = one('entity_name');
          const ids: Record<string, string> = {};
          const fileNo = one('file_number');
          const ein = one('ein');
          if (fileNo) ids.file_number = str(fileNo.value);
          if (ein) ids.ein = str(ein.value);
          const formation = one('formation_date');
          await tx.query(
            `update entities set identifiers = $2::jsonb || identifiers, attributes = $3::jsonb || attributes,
                    jurisdiction = coalesce(jurisdiction, $4) where id = $1`,
            [
              subjectId,
              JSON.stringify(ids),
              JSON.stringify(formation ? { formation_date: formation.value } : {}),
              one('jurisdiction') ? str(one('jurisdiction')!.value) : null,
            ],
          );
          if (name) await mention(b, subjectId, name, str(name.value), 'subject');
          break;
        }
        case 'beneficial_ownership': {
          const certified = one('certification_date')?.value as string | undefined;
          const name = one('entity_name');
          if (name) await mention(b, subjectId, name, str(name.value), 'subject');
          for (const g of groups(facts, 'beneficial_owner')) {
            if (!g.name) continue;
            const ownerId = await party(b, str(g.name.value), c.subject_name, {
              attributes: { ...(g.dob ? { dob: g.dob.value } : {}), ...(g.address ? { address: g.address.value } : {}) },
            });
            await mention(b, ownerId, g.name, str(g.name.value), 'beneficial_owner');
            push(
              await assert(b, {
                source: subjectId,
                target: ownerId,
                type: 'OWNED_BY',
                pct: (g.ownership_pct?.value as number | undefined) ?? null,
                facts: [g.name, g.ownership_pct],
                validFrom: certified ?? null,
              }),
            );
          }
          const cp = one('control_person_name');
          if (cp) {
            const id = await party(b, str(cp.value), c.subject_name);
            await mention(b, id, cp, str(cp.value), 'control_person');
            push(
              await assert(b, {
                source: id,
                target: subjectId,
                type: 'OFFICER_OF',
                title: one('control_person_title') ? str(one('control_person_title')!.value) : 'Control person',
                facts: [cp, one('control_person_title')],
                validFrom: certified ?? null,
              }),
            );
          }
          break;
        }
        case 'director_register': {
          for (const g of groups(facts, 'director')) {
            if (!g.name) continue;
            const id = await party(b, str(g.name.value), c.subject_name);
            await mention(b, id, g.name, str(g.name.value), 'director');
            push(
              await assert(b, {
                source: id,
                target: subjectId,
                type: 'DIRECTOR_OF',
                title: g.position ? str(g.position.value) : null,
                facts: [g.name, g.position, g.appointed],
                validFrom: (g.appointed?.value as string | undefined) ?? null,
              }),
            );
          }
          break;
        }
        case 'ownership_chart': {
          const asOf = (one('as_of')?.value as string | undefined) ?? null;
          for (const g of groups(facts, 'ownership_edge')) {
            if (!g.owner || !g.owned) continue;
            const owned = await party(b, str(g.owned.value), c.subject_name);
            const owner = await party(b, str(g.owner.value), c.subject_name);
            await mention(b, owned, g.owned, str(g.owned.value), 'owned_entity');
            await mention(b, owner, g.owner, str(g.owner.value), 'owner');
            push(
              await assert(b, {
                source: owned,
                target: owner,
                type: 'OWNED_BY',
                pct: (g.pct?.value as number | undefined) ?? null,
                facts: [g.owner, g.owned, g.pct],
                validFrom: asOf,
              }),
            );
          }
          break;
        }
        default:
          break;
      }

      await reconcileCase(tx, c.id);
      if (created.length) {
        await emitEvent(tx, {
          tenantId: b.tenantId,
          type: 'entity.relationship_changed',
          resource: { type: 'case', id: c.id },
          data: { document_id: s.document.id, version_id: s.version.id, relationships: created.length, change: 'extracted' },
        });
      }
      return { relationships: created.length, subject_entity_id: subjectId };
    });
  },
};
