import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ENTITY_KINDS, RELATIONSHIP_TYPES } from '@fingraph/shared';
import type { AuthContext } from '../../context';
import type { Tx } from '../../db';
import { conflict, notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { getVisibleCase, isClosed } from '../cases/access';
import { getVisibleDocument } from '../documents/access';
import { emitEvent } from '../events/outbox';
import { ensureSubjectEntity, reconcileCase } from './build';
import { caseDiscrepancies } from './discrepancies';
import { caseGraph, ownershipRollup, traverse } from './queries';
import { resolveEntity } from './resolve';

const bool = (d: boolean) =>
  z
    .enum(['true', 'false'])
    .default(d ? 'true' : 'false')
    .transform((v) => v === 'true');

/** An entity is visible when the caller can see a document that mentions or relates it. */
async function getVisibleEntity(tx: Tx, auth: AuthContext, id: string) {
  const e = await tx.one(
    `select e.* from entities e where e.id = $1 and (
        exists (select 1 from entity_mentions m join documents d on d.id = m.document_id
                 where m.entity_id = e.id and d.deleted_at is null and fg_document_visible(d, $2::uuid))
     or exists (select 1 from entity_relationships r
                 where (r.source_entity_id = e.id or r.target_entity_id = e.id) and fg_relationship_visible(r, $2::uuid))
     or exists (select 1 from cases c where c.subject_entity_id = e.id and fg_case_visible(c, $2::uuid)))`,
    [id, auth.userId],
  );
  if (!e) throw notFound('Entity');
  return e;
}

async function getVisibleRelationship(tx: Tx, auth: AuthContext, id: string) {
  const r = await tx.one<{ id: string; case_id: string; review_status: string; source_entity_id: string; target_entity_id: string; relationship_type: string }>(
    `select r.* from entity_relationships r where r.id = $1 and fg_relationship_visible(r, $2::uuid) for update`,
    [id, auth.userId],
  );
  if (!r) throw notFound('Relationship');
  return r;
}

export async function graphRoutes(app: FastifyInstance) {
  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/graph',
    summary: 'Entities and evidence-backed relationships for a case',
    tags: ['graph'],
    permission: 'graph:read',
    scopes: ['graph:read'],
    params: uuidParam,
    query: z.object({ include_unverified: bool(true), include_historical: bool(false) }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return caseGraph(t, params.id, auth.userId, { includeUnverified: query.include_unverified, includeHistorical: query.include_historical });
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/ownership',
    summary: 'Effective (direct and indirect) ownership of the case subject',
    tags: ['graph'],
    permission: 'graph:read',
    scopes: ['graph:read'],
    params: uuidParam,
    query: z.object({ threshold: z.coerce.number().min(0).max(100).default(25) }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return ownershipRollup(t, params.id, auth.userId, query.threshold);
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/discrepancies',
    summary: 'Missing, inconsistent or outdated information found in the case evidence',
    tags: ['graph'],
    permission: 'case:read',
    scopes: ['cases:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        return { items: await caseDiscrepancies(t, params.id, auth.userId) };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/entities',
    summary: 'Search entities you can see',
    tags: ['graph'],
    permission: 'graph:read',
    query: z.object({ q: z.string().trim().min(2).max(100), kind: z.enum(ENTITY_KINDS).optional() }),
    handler: async ({ query, auth, tx }) => ({
      items: await tx((t) =>
        t.many(
          `select e.id, e.kind, e.display_name, e.status, e.jurisdiction, e.identifiers,
                  (select count(distinct m.case_id)::int from entity_mentions m where m.entity_id = e.id) as case_count
             from entities e
            where e.status <> 'merged' and lower(e.display_name) like $1 and ($3::text is null or e.kind = $3)
              and exists (select 1 from entity_mentions m join documents d on d.id = m.document_id
                           where m.entity_id = e.id and d.deleted_at is null and fg_document_visible(d, $2::uuid))
            order by e.display_name limit 50`,
          [`%${query.q.toLowerCase()}%`, auth.userId, query.kind ?? null],
        ),
      ),
    }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/entities/duplicates',
    summary: 'Possible duplicate entities awaiting a decision',
    tags: ['graph'],
    permission: 'graph:read',
    query: z.object({ status: z.enum(['open', 'merged', 'dismissed']).default('open') }),
    handler: async ({ query, tx }) => ({
      items: await tx((t) =>
        t.many(
          `select x.*, a.display_name as a_name, a.kind as a_kind, a.attributes as a_attributes,
                  b.display_name as b_name, b.kind as b_kind, b.attributes as b_attributes
             from entity_duplicates x join entities a on a.id = x.entity_a join entities b on b.id = x.entity_b
            where x.status = $1 order by x.score desc, x.created_at`,
          [query.status],
        ),
      ),
    }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/entities/duplicates/:id/resolve',
    summary: 'Merge two entities or dismiss the duplicate suggestion',
    tags: ['graph'],
    permission: 'graph:edit',
    params: uuidParam,
    body: z.object({ action: z.enum(['merge', 'dismiss']), keep: z.uuid().optional(), comment: z.string().trim().max(1000).optional() }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const d = await t.one<{ id: string; entity_a: string; entity_b: string; status: string }>(
          'select * from entity_duplicates where id = $1 for update',
          [params.id],
        );
        if (!d) throw notFound('Duplicate');
        if (d.status !== 'open') throw conflict('This suggestion was already resolved.');
        await getVisibleEntity(t, auth, d.entity_a);
        await getVisibleEntity(t, auth, d.entity_b);
        if (body.action === 'dismiss') {
          await t.query(`update entity_duplicates set status = 'dismissed', resolved_by = $2, resolved_at = now() where id = $1`, [d.id, auth.userId]);
          await audit(t, req, { action: 'entity.duplicate_dismissed', resourceType: 'entity', resourceId: d.entity_a, details: { other: d.entity_b, comment: body.comment } });
          return { status: 'dismissed' };
        }
        const keep = body.keep ?? d.entity_a;
        if (keep !== d.entity_a && keep !== d.entity_b) throw unprocessable('invalid_keep', 'keep must be one of the two entities.');
        const drop = keep === d.entity_a ? d.entity_b : d.entity_a;
        await t.query('update entity_mentions set entity_id = $1 where entity_id = $2', [keep, drop]);
        await t.query('update entity_relationships set source_entity_id = $1 where source_entity_id = $2', [keep, drop]);
        await t.query('update entity_relationships set target_entity_id = $1 where target_entity_id = $2', [keep, drop]);
        await t.query('delete from entity_relationships where source_entity_id = target_entity_id');
        await t.query('update cases set subject_entity_id = $1 where subject_entity_id = $2', [keep, drop]);
        await t.query(
          `update entities k set identifiers = d.identifiers || k.identifiers, attributes = d.attributes || k.attributes
             from entities d where k.id = $1 and d.id = $2`,
          [keep, drop],
        );
        await t.query(`update entities set status = 'merged', merged_into = $1 where id = $2`, [keep, drop]);
        await t.query(`update entity_duplicates set status = 'merged', resolved_by = $2, resolved_at = now() where id = $1`, [d.id, auth.userId]);
        const cases = await t.many<{ case_id: string }>('select distinct case_id from entity_relationships where source_entity_id = $1 or target_entity_id = $1', [keep]);
        for (const c of cases) await reconcileCase(t, c.case_id);
        await audit(t, req, { action: 'entity.merged', resourceType: 'entity', resourceId: keep, details: { merged: drop, comment: body.comment } });
        await emitEvent(t, {
          tenantId: auth.tenantId,
          type: 'entity.relationship_changed',
          resource: { type: 'entity', id: keep },
          data: { change: 'merged', merged_entity_id: drop },
          correlationId: req.id,
        });
        return { status: 'merged', kept: keep, merged: drop };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/entities/:id',
    summary: 'Entity profile with its mentions in visible documents',
    tags: ['graph'],
    permission: 'graph:read',
    scopes: ['graph:read'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const e = await getVisibleEntity(t, auth, params.id);
        const mentions = await t.many(
          `select m.id, m.case_id, c.reference as case_reference, m.document_id, d.title as document_title, m.version_id,
                  m.fact_id, m.mention_text, m.role, m.page_no
             from entity_mentions m join documents d on d.id = m.document_id join cases c on c.id = m.case_id
            where m.entity_id = $1 and d.deleted_at is null and fg_document_visible(d, $2::uuid)
            order by m.created_at`,
          [params.id, auth.userId],
        );
        return { ...e, mentions };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/entities/:id/relationships',
    summary: 'Relationships around an entity (bounded multi-hop traversal)',
    tags: ['graph'],
    permission: 'graph:read',
    scopes: ['graph:read'],
    params: uuidParam,
    query: z.object({
      depth: z.coerce.number().int().min(1).max(4).default(1),
      include_unverified: bool(true),
      include_historical: bool(false),
    }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleEntity(t, auth, params.id);
        return traverse(t, params.id, auth.userId, query.depth, {
          includeUnverified: query.include_unverified,
          includeHistorical: query.include_historical,
        });
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/relationships/:id/reviews',
    summary: 'Verify or reject a relationship assertion',
    tags: ['graph'],
    permission: 'graph:edit',
    params: uuidParam,
    body: z
      .object({ action: z.enum(['verify', 'reject', 'reopen']), comment: z.string().trim().max(2000).optional() })
      .refine((b) => b.action === 'verify' || (b.comment && b.comment.length >= 3), { path: ['comment'], message: 'Explain the decision.' }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const r = await getVisibleRelationship(t, auth, params.id);
        const c = await getVisibleCase(t, auth, r.case_id);
        if (isClosed(c)) throw conflict('Relationships on a closed case cannot be changed.');
        const next = body.action === 'verify' ? 'verified' : body.action === 'reject' ? 'rejected' : 'candidate';
        if (body.action === 'reopen' ? r.review_status === 'candidate' : r.review_status === next) {
          throw conflict(`The relationship is already ${r.review_status}.`);
        }
        await t.query(
          `insert into relationship_reviews (tenant_id, relationship_id, action, previous_status, new_status, comment, reviewer_id)
           values ($1,$2,$3,$4,$5,$6,$7)`,
          [auth.tenantId, r.id, body.action, r.review_status, next, body.comment ?? null, auth.userId],
        );
        const updated = await t.one(
          `update entity_relationships set review_status = $2, reviewed_by = $3, reviewed_at = now(), review_comment = $4
            where id = $1 returning *`,
          [r.id, next, auth.userId, body.comment ?? null],
        );
        if (body.action !== 'verify') await reconcileCase(t, r.case_id);
        await audit(t, req, {
          action: `relationship.${next}`,
          resourceType: 'relationship',
          resourceId: r.id,
          details: { case_id: r.case_id, previous_status: r.review_status, comment: body.comment ?? null },
        });
        await emitEvent(t, {
          tenantId: auth.tenantId,
          type: 'entity.relationship_changed',
          resource: { type: 'relationship', id: r.id },
          data: { case_id: r.case_id, change: next, relationship_type: r.relationship_type },
          correlationId: req.id,
        });
        return updated;
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/relationships',
    summary: 'Record a relationship manually; evidence in a case document is required',
    tags: ['graph'],
    permission: 'graph:edit',
    status: 201,
    params: uuidParam,
    body: z.object({
      source: z.union([z.object({ entity_id: z.uuid() }), z.object({ name: z.string().trim().min(2).max(200), kind: z.enum(ENTITY_KINDS) })]),
      target: z.union([z.object({ entity_id: z.uuid() }), z.object({ name: z.string().trim().min(2).max(200), kind: z.enum(ENTITY_KINDS) })]),
      relationship_type: z.enum(RELATIONSHIP_TYPES),
      ownership_pct: z.number().min(0).max(100).optional(),
      role_title: z.string().trim().max(200).optional(),
      evidence_document_id: z.uuid(),
      evidence_page: z.number().int().min(1).optional(),
      evidence_quote: z.string().trim().min(3).max(2000),
      valid_from: z.iso.date().optional(),
    }),
    handler: async ({ params, body, auth, req, tx }) =>
      tx(async (t) => {
        const c = await getVisibleCase(t, auth, params.id);
        if (isClosed(c)) throw conflict('Closed cases cannot be changed.');
        const doc = await getVisibleDocument(t, auth, body.evidence_document_id);
        if (doc.case_id !== c.id) throw unprocessable('evidence_not_in_case', 'The evidence document must belong to this case.');
        await ensureSubjectEntity(t, auth.tenantId, c);
        const pick = async (p: typeof body.source) =>
          'entity_id' in p ? (await getVisibleEntity(t, auth, p.entity_id)).id : (await resolveEntity(t, auth.tenantId, { kind: p.kind, name: p.name })).id;
        const source = await pick(body.source);
        const target = await pick(body.target);
        if (source === target) throw unprocessable('self_relationship', 'An entity cannot relate to itself.');
        const r = await t.one(
          `insert into entity_relationships (tenant_id, case_id, source_entity_id, target_entity_id, relationship_type, ownership_pct,
                                             role_title, evidence_document_id, evidence_document_version_id, evidence_page,
                                             evidence_quote, origin, confidence, valid_from, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'manual',1,$12,$13) returning *`,
          [
            auth.tenantId,
            c.id,
            source,
            target,
            body.relationship_type,
            body.ownership_pct ?? null,
            body.role_title ?? null,
            doc.id,
            doc.current_version_id,
            body.evidence_page ?? null,
            body.evidence_quote,
            body.valid_from ?? null,
            auth.userId,
          ],
        );
        await reconcileCase(t, c.id);
        await audit(t, req, { action: 'relationship.created', resourceType: 'relationship', resourceId: r!.id, details: { case_id: c.id, ...body } });
        await emitEvent(t, {
          tenantId: auth.tenantId,
          type: 'entity.relationship_changed',
          resource: { type: 'relationship', id: r!.id },
          data: { case_id: c.id, change: 'created', relationship_type: body.relationship_type },
          correlationId: req.id,
        });
        return r;
      }),
  });
}
