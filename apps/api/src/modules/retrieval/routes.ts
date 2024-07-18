import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { DOCUMENT_CATEGORIES } from '@fingraph/shared';
import { notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';
import { getVisibleCase } from '../cases/access';
import { documentVisibleSql, getVisibleDocument } from '../documents/access';
import { compareVersions } from './compare';
import { askQuestion } from './rag';
import { hybridSearch } from './search';

const searchQuery = z.object({
  q: z.string().trim().min(2).max(300),
  mode: z.enum(['hybrid', 'keyword', 'semantic']).default('hybrid'),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export async function retrievalRoutes(app: FastifyInstance) {
  const { embeddings } = app.ctx;

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/search',
    summary: 'Keyword, semantic or hybrid search within a case',
    tags: ['search'],
    permission: 'document:read',
    scopes: ['documents:read'],
    params: uuidParam,
    query: searchQuery,
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const items = await hybridSearch(t, { query: query.q, mode: query.mode, limit: query.limit, caseId: params.id, userId: auth.userId, embeddings });
        return { items, mode: query.mode };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/search',
    summary: 'Search every case and document you can access',
    tags: ['search'],
    permission: 'document:read',
    scopes: ['documents:read'],
    query: searchQuery,
    rateLimit: { max: 120, windowMs: 60_000 },
    handler: async ({ query, auth, tx }) =>
      tx(async (t) => ({
        items: await hybridSearch(t, { query: query.q, mode: query.mode, limit: query.limit, userId: auth.userId, embeddings }),
        mode: query.mode,
      })),
  });

  route(app, {
    method: 'POST',
    url: '/v1/cases/:id/questions',
    summary: 'Ask an evidence-grounded question about a case',
    tags: ['search'],
    permission: 'rag:query',
    scopes: ['rag:query'],
    params: uuidParam,
    body: z.object({
      question: z.string().trim().min(5).max(1000),
      document_ids: z.array(z.uuid()).max(50).optional(),
      use_graph: z.boolean().default(true),
    }),
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async ({ params, body, auth, req, tx }) => {
      await tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        if (body.document_ids) {
          const visible = await t.many<{ id: string }>(
            `select d.id from documents d where d.id = any($1) and d.case_id = $2 and d.deleted_at is null and ${documentVisibleSql('d', '$3')}`,
            [body.document_ids, params.id, auth.userId],
          );
          // an id the caller cannot see is indistinguishable from one that does not exist
          if (visible.length !== new Set(body.document_ids).size) throw notFound('Document');
        }
      });
      const result = await askQuestion(app.ctx, auth, { caseId: params.id, question: body.question, documentIds: body.document_ids, useGraph: body.use_graph }, tx);
      await tx((t) =>
        audit(t, req, {
          action: 'ai.question_answered',
          resourceType: 'ai_interaction',
          resourceId: result.id,
          details: { case_id: params.id, status: result.status, citations: result.citations.length, flags: result.flags },
        }),
      );
      return result;
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/questions',
    summary: 'Question history for a case',
    tags: ['search'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        // Only show interactions whose cited sources the caller can still see.
        const rows = await t.many(
          `select i.id, i.question, i.status, i.answer, i.claims, i.citations, i.missing, i.flags, i.provider, i.model,
                  i.prompt_version, i.feedback, i.created_at, u.display_name as asked_by
             from ai_interactions i left join users u on u.id = i.user_id
            where i.case_id = $1
              and not exists (select 1 from unnest(i.source_versions) sv
                               join document_versions v on v.id = sv join documents d on d.id = v.document_id
                              where not ${documentVisibleSql('d', '$2')} or d.deleted_at is not null)
            order by i.created_at desc limit 100`,
          [params.id, auth.userId],
        );
        return { items: rows };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/ai-interactions/:id',
    summary: 'Full provenance record for an AI answer',
    tags: ['search'],
    permission: 'case:read',
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const i = await t.one<{ case_id: string; source_versions: string[] }>('select * from ai_interactions where id = $1', [params.id]);
        if (!i) throw notFound('Interaction');
        await getVisibleCase(t, auth, i.case_id);
        const hidden = await t.one<{ n: number }>(
          `select count(*)::int as n from document_versions v join documents d on d.id = v.document_id
            where v.id = any($1) and (not ${documentVisibleSql('d', '$2')} or d.deleted_at is not null)`,
          [i.source_versions, auth.userId],
        );
        if (hidden!.n > 0) throw notFound('Interaction');
        return i;
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/ai-interactions/:id/feedback',
    summary: 'Rate an AI answer',
    tags: ['search'],
    permission: 'rag:query',
    params: uuidParam,
    body: z.object({ feedback: z.enum(['helpful', 'not_helpful']) }),
    handler: async ({ params, body, auth, tx }) =>
      tx(async (t) => {
        const r = await t.one('update ai_interactions set feedback = $2 where id = $1 and user_id = $3 returning id, feedback', [
          params.id,
          body.feedback,
          auth.userId,
        ]);
        if (!r) throw notFound('Interaction');
        return r;
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/documents/:id/compare',
    summary: 'Compare two versions of a document, or this document with another of the same type',
    tags: ['search'],
    permission: 'document:read',
    params: uuidParam,
    query: z.object({ from_version_id: z.uuid().optional(), to_version_id: z.uuid().optional(), with_document_id: z.uuid().optional() }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        const d = await getVisibleDocument(t, auth, params.id);
        if (query.with_document_id) {
          const other = await getVisibleDocument(t, auth, query.with_document_id);
          if (other.case_id !== d.case_id) throw unprocessable('different_case', 'Both documents must belong to the same case.');
          return compareVersions(t, other.current_version_id!, d.current_version_id!);
        }
        const versions = await t.many<{ id: string; version_no: number }>(
          `select id, version_no from document_versions where document_id = $1 and status = 'processed' order by version_no`,
          [d.id],
        );
        const ids = new Set(versions.map((v) => v.id));
        const from = query.from_version_id ?? versions[versions.length - 2]?.id;
        const to = query.to_version_id ?? versions[versions.length - 1]?.id;
        if (!from || !to || !ids.has(from) || !ids.has(to)) {
          throw unprocessable('nothing_to_compare', 'Two processed versions are needed to compare.');
        }
        return compareVersions(t, from, to);
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/cases/:id/compare',
    summary: 'Compare the oldest and newest documents of a category within a case (changes over time)',
    tags: ['search'],
    permission: 'document:read',
    params: uuidParam,
    query: z.object({ category: z.enum(DOCUMENT_CATEGORIES) }),
    handler: async ({ params, query, auth, tx }) =>
      tx(async (t) => {
        await getVisibleCase(t, auth, params.id);
        const docs = await t.many<{ id: string; title: string; current_version_id: string; evidence_date: Date | null }>(
          `select d.id, d.title, d.current_version_id, d.evidence_date from documents d
             join document_versions v on v.id = d.current_version_id
            where d.case_id = $1 and d.category = $2 and d.deleted_at is null and v.status = 'processed'
              and ${documentVisibleSql('d', '$3')}
            order by d.evidence_date nulls first, d.created_at`,
          [params.id, query.category, auth.userId],
        );
        if (docs.length < 2) throw unprocessable('nothing_to_compare', 'At least two documents of this type are needed.');
        const first = docs[0]!;
        const last = docs[docs.length - 1]!;
        return {
          from: { document_id: first.id, title: first.title, evidence_date: first.evidence_date },
          to: { document_id: last.id, title: last.title, evidence_date: last.evidence_date },
          ...(await compareVersions(t, first.current_version_id, last.current_version_id)),
        };
      }),
  });
}
