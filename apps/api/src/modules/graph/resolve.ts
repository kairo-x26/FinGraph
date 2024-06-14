import type { EntityKind } from '@fingraph/shared';
import type { Tx } from '../../db';
import { normalizeName } from '../extraction/normalize';

/** Jaro-Winkler similarity in [0, 1]. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const am = new Array(a.length).fill(false);
  const bm = new Array(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = Math.max(0, i - range); j < Math.min(b.length, i + range + 1); j++) {
      if (bm[j] || a[i] !== b[j]) continue;
      am[i] = bm[j] = true;
      matches++;
      break;
    }
  }
  if (!matches) return 0;
  let t = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!am[i]) continue;
    while (!bm[k]) k++;
    if (a[i] !== b[k]) t++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - t / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < 4 && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** Token-order-insensitive similarity ("Gonzalez Maria" vs "Maria Gonzalez"). */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  const sorted = (s: string) => s.split(' ').sort().join(' ');
  return Math.max(jaroWinkler(na, nb), jaroWinkler(sorted(na), sorted(nb)));
}

export interface EntityInput {
  kind: EntityKind;
  name: string;
  identifiers?: Record<string, string>;
  attributes?: Record<string, unknown>;
  jurisdiction?: string | null;
}

export interface Resolution {
  id: string;
  created: boolean;
  /** How the entity was matched. */
  method: 'identifier' | 'exact_name' | 'new';
  confidence: number;
}

const FUZZY_THRESHOLD = 0.9;

/**
 * Resolves a mention to an entity within the tenant. Identifiers and exact
 * normalized names are matched deterministically; close-but-not-equal names create
 * a new entity plus a duplicate candidate for a human to merge or dismiss.
 */
export async function resolveEntity(tx: Tx, tenantId: string, input: EntityInput): Promise<Resolution> {
  const normalized = normalizeName(input.name);
  const ids = input.identifiers ?? {};

  for (const key of ['ein', 'file_number'] as const) {
    if (!ids[key]) continue;
    const hit = await tx.one<{ id: string }>(
      `select id from entities where kind = $1 and identifiers->>$2 = $3 and status <> 'merged' limit 1`,
      [input.kind, key, ids[key]],
    );
    if (hit) {
      await mergeAttributes(tx, hit.id, input);
      return { id: hit.id, created: false, method: 'identifier', confidence: 1 };
    }
  }

  const exact = await tx.many<{ id: string; attributes: Record<string, unknown>; identifiers: Record<string, string> }>(
    `select id, attributes, identifiers from entities where kind = $1 and normalized_name = $2 and status <> 'merged'`,
    [input.kind, normalized],
  );
  // a conflicting date of birth or identifier means a different person/company with the same name
  const compatible = exact.find((e) => {
    const dobA = e.attributes?.dob;
    const dobB = input.attributes?.dob;
    if (dobA && dobB && dobA !== dobB) return false;
    for (const k of ['ein', 'file_number']) if (e.identifiers?.[k] && ids[k] && e.identifiers[k] !== ids[k]) return false;
    return true;
  });
  if (compatible) {
    await mergeAttributes(tx, compatible.id, input);
    return { id: compatible.id, created: false, method: 'exact_name', confidence: 0.95 };
  }

  const created = (await tx.one<{ id: string }>(
    `insert into entities (tenant_id, kind, display_name, normalized_name, jurisdiction, identifiers, attributes)
     values ($1,$2,$3,$4,$5,$6,$7) returning id`,
    [
      tenantId,
      input.kind,
      input.name.trim(),
      normalized,
      input.jurisdiction ?? null,
      JSON.stringify(ids),
      JSON.stringify(input.attributes ?? {}),
    ],
  ))!;

  // flag near matches as possible duplicates (KG-04)
  const candidates = await tx.many<{ id: string; display_name: string; normalized_name: string; attributes: Record<string, unknown> }>(
    `select id, display_name, normalized_name, attributes from entities
      where kind = $1 and status <> 'merged' and id <> $2
        and (left(normalized_name, 2) = left($3, 2) or split_part(normalized_name, ' ', 2) = split_part($3, ' ', 2))
      limit 200`,
    [input.kind, created.id, normalized],
  );
  for (const c of [...exact, ...candidates]) {
    const other = 'display_name' in c ? (c as { display_name: string }).display_name : input.name;
    const score = 'display_name' in c ? nameSimilarity(input.name, other) : 1;
    if (score < FUZZY_THRESHOLD) continue;
    const reasons = [score === 1 ? 'same_name_conflicting_attributes' : 'similar_name'];
    const [a, b] = [created.id, c.id].sort();
    await tx.query(
      `insert into entity_duplicates (tenant_id, entity_a, entity_b, score, reasons) values ($1,$2,$3,$4,$5)
       on conflict (entity_a, entity_b) do nothing`,
      [tenantId, a, b, Math.round(score * 10000) / 10000, JSON.stringify(reasons)],
    );
  }
  return { id: created.id, created: true, method: 'new', confidence: 0.9 };
}

async function mergeAttributes(tx: Tx, id: string, input: EntityInput) {
  await tx.query(
    `update entities set identifiers = $2::jsonb || identifiers, attributes = $3::jsonb || attributes,
            jurisdiction = coalesce(jurisdiction, $4)
      where id = $1`,
    [id, JSON.stringify(input.identifiers ?? {}), JSON.stringify(input.attributes ?? {}), input.jurisdiction ?? null],
  );
}
