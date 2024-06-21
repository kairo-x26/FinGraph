import type { Tx } from '../../db';

export interface Edge {
  id: string;
  case_id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  ownership_pct: number | null;
  role_title: string | null;
  evidence_document_id: string;
  evidence_document_version_id: string;
  evidence_page: number | null;
  evidence_quote: string | null;
  evidence_document_title?: string;
  evidence_document_category?: string | null;
  origin: string;
  confidence: number | null;
  review_status: string;
  valid_from: Date | null;
  valid_to: Date | null;
  created_at: Date;
}

export interface Node {
  id: string;
  kind: 'organization' | 'individual';
  display_name: string;
  status: string;
  jurisdiction: string | null;
  identifiers: Record<string, string>;
  attributes: Record<string, unknown>;
}

export const LIMITS = { maxDepth: 4, maxNodes: 200, maxEdges: 1000, timeoutMs: 2000 };

const EDGE_SELECT = `r.id, r.case_id, r.source_entity_id, r.target_entity_id, r.relationship_type, r.ownership_pct, r.role_title,
  r.evidence_document_id, r.evidence_document_version_id, r.evidence_page, r.evidence_quote, r.origin, r.confidence,
  r.review_status, r.valid_from, r.valid_to, r.created_at, r.reviewed_by, r.reviewed_at, r.review_comment,
  d.title as evidence_document_title, d.category as evidence_document_category`;

export interface EdgeFilter {
  includeUnverified: boolean;
  includeHistorical: boolean;
}

function edgeConditions(f: EdgeFilter, userParam = '$2') {
  const c = [`r.review_status <> 'rejected'`, `d.deleted_at is null`, `fg_document_visible(d, ${userParam}::uuid)`];
  if (!f.includeUnverified) c.push(`r.review_status = 'verified'`);
  if (!f.includeHistorical) c.push(`(r.valid_to is null or r.valid_to > now())`);
  return c.join(' and ');
}

async function nodesFor(tx: Tx, ids: string[]): Promise<Node[]> {
  if (!ids.length) return [];
  return tx.many<Node>(
    `select id, kind, display_name, status, jurisdiction, identifiers, attributes from entities where id = any($1)`,
    [ids],
  );
}

/** All visible relationships evidenced in one case. */
export async function caseGraph(tx: Tx, caseId: string, userId: string | null, f: EdgeFilter) {
  const edges = await tx.many<Edge>(
    `select ${EDGE_SELECT} from entity_relationships r join documents d on d.id = r.evidence_document_id
      where r.case_id = $1 and ${edgeConditions(f)} order by r.created_at`,
    [caseId, userId],
  );
  const subject = await tx.one<{ subject_entity_id: string | null }>('select subject_entity_id from cases where id = $1', [caseId]);
  const ids = new Set(edges.flatMap((e) => [e.source_entity_id, e.target_entity_id]));
  if (subject?.subject_entity_id) ids.add(subject.subject_entity_id);
  return { subject_entity_id: subject?.subject_entity_id ?? null, nodes: await nodesFor(tx, [...ids]), edges };
}

/**
 * Bounded breadth-first traversal around an entity across every case the caller
 * can see. Depth, node count and query time are capped.
 */
export async function traverse(tx: Tx, entityId: string, userId: string | null, depth: number, f: EdgeFilter) {
  await tx.query(`set local statement_timeout = ${LIMITS.timeoutMs}`);
  const maxDepth = Math.min(Math.max(1, depth), LIMITS.maxDepth);
  const visited = new Map<string, number>([[entityId, 0]]);
  const edges = new Map<string, Edge>();
  let frontier = [entityId];
  let truncated = false;
  for (let level = 1; level <= maxDepth && frontier.length; level++) {
    const rows = await tx.many<Edge>(
      `select ${EDGE_SELECT} from entity_relationships r join documents d on d.id = r.evidence_document_id
        where (r.source_entity_id = any($1) or r.target_entity_id = any($1)) and ${edgeConditions(f)}
        limit ${LIMITS.maxEdges + 1}`,
      [frontier, userId],
    );
    const next: string[] = [];
    for (const e of rows) {
      if (edges.size >= LIMITS.maxEdges) {
        truncated = true;
        break;
      }
      edges.set(e.id, e);
      for (const n of [e.source_entity_id, e.target_entity_id]) {
        if (visited.has(n)) continue;
        if (visited.size >= LIMITS.maxNodes) {
          truncated = true;
          continue;
        }
        visited.set(n, level);
        next.push(n);
      }
    }
    frontier = next;
  }
  // only keep edges whose both ends were admitted
  const kept = [...edges.values()].filter((e) => visited.has(e.source_entity_id) && visited.has(e.target_entity_id));
  const nodes = (await nodesFor(tx, [...visited.keys()])).map((n) => ({ ...n, depth: visited.get(n.id)! }));
  return { root: entityId, depth: maxDepth, truncated, nodes, edges: kept, limits: LIMITS };
}

export interface OwnershipChain {
  owner_id: string;
  path: { entity_id: string; pct: number; relationship_id: string }[];
  effective_pct: number;
}

export interface BeneficialOwner {
  entity_id: string;
  display_name: string;
  kind: string;
  effective_pct: number;
  direct_pct: number;
  chains: OwnershipChain[];
  declared: boolean;
  verified: boolean;
}

/**
 * Rolls up effective ownership from the case subject by multiplying percentages
 * along OWNED_BY chains (current, non-rejected claims only).
 */
export async function ownershipRollup(tx: Tx, caseId: string, userId: string | null, threshold = 25) {
  const c = await tx.one<{ subject_entity_id: string | null }>('select subject_entity_id from cases where id = $1', [caseId]);
  if (!c?.subject_entity_id) return { subject_entity_id: null, threshold, owners: [] as BeneficialOwner[] };
  const edges = await tx.many<Edge & { evidence_document_category: string | null }>(
    `select ${EDGE_SELECT} from entity_relationships r join documents d on d.id = r.evidence_document_id
      where r.case_id = $1 and r.relationship_type = 'OWNED_BY' and r.ownership_pct is not null
        and ${edgeConditions({ includeUnverified: true, includeHistorical: false })}`,
    [caseId, userId],
  );
  // dedupe: the same owner→owned pair may be asserted by several documents; prefer verified, then latest
  const best = new Map<string, Edge>();
  for (const e of edges) {
    const k = `${e.source_entity_id}|${e.target_entity_id}`;
    const cur = best.get(k);
    if (!cur || (e.review_status === 'verified' && cur.review_status !== 'verified')) best.set(k, e);
  }
  const ownersOf = new Map<string, Edge[]>();
  for (const e of best.values()) ownersOf.set(e.source_entity_id, [...(ownersOf.get(e.source_entity_id) ?? []), e]);

  const chains: OwnershipChain[] = [];
  const walk = (entity: string, pct: number, path: OwnershipChain['path'], seen: Set<string>) => {
    for (const e of ownersOf.get(entity) ?? []) {
      if (seen.has(e.target_entity_id) || path.length >= 6) continue;
      const p = (pct * Number(e.ownership_pct)) / 100;
      const nextPath = [...path, { entity_id: e.target_entity_id, pct: Number(e.ownership_pct), relationship_id: e.id }];
      chains.push({ owner_id: e.target_entity_id, path: nextPath, effective_pct: Math.round(p * 10000) / 10000 });
      walk(e.target_entity_id, p, nextPath, new Set([...seen, e.target_entity_id]));
    }
  };
  walk(c.subject_entity_id, 100, [], new Set([c.subject_entity_id]));

  const declaredOwners = new Set(
    edges
      .filter((e) => e.source_entity_id === c.subject_entity_id && e.evidence_document_category === 'beneficial_ownership')
      .map((e) => e.target_entity_id),
  );
  const nodes = await nodesFor(tx, [...new Set(chains.map((ch) => ch.owner_id))]);
  const owners: BeneficialOwner[] = nodes.map((n) => {
    const mine = chains.filter((ch) => ch.owner_id === n.id);
    const direct = mine.filter((ch) => ch.path.length === 1).reduce((s, ch) => s + ch.effective_pct, 0);
    return {
      entity_id: n.id,
      display_name: n.display_name,
      kind: n.kind,
      effective_pct: Math.round(mine.reduce((s, ch) => s + ch.effective_pct, 0) * 100) / 100,
      direct_pct: Math.round(direct * 100) / 100,
      chains: mine,
      declared: declaredOwners.has(n.id),
      verified: mine.every((ch) => ch.path.every((p) => edges.find((e) => e.id === p.relationship_id)?.review_status === 'verified')),
    };
  });
  owners.sort((a, b) => b.effective_pct - a.effective_pct);
  return { subject_entity_id: c.subject_entity_id, threshold, owners };
}
