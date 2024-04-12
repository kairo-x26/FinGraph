import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { decodeCursor, paginationQuery, route } from '../../lib/http';
import { verifyAuditChain } from './service';

const listQuery = paginationQuery.extend({
  resource_type: z.string().max(64).optional(),
  resource_id: z.string().max(128).optional(),
  actor_id: z.string().max(128).optional(),
  action: z.string().max(128).optional(),
  since: z.iso.datetime().optional(),
  until: z.iso.datetime().optional(),
});

export async function auditRoutes(app: FastifyInstance) {
  route(app, {
    method: 'GET',
    url: '/v1/audit/events',
    summary: 'List audit events for the tenant (newest first)',
    tags: ['audit'],
    permission: 'audit:read',
    scopes: ['audit:read'],
    query: listQuery,
    handler: async ({ query, tx }) => {
      const where: string[] = [];
      const params: unknown[] = [];
      const add = (sql: string, v: unknown) => {
        params.push(v);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (query.resource_type) add('resource_type = ?', query.resource_type);
      if (query.resource_id) add('resource_id = ?', query.resource_id);
      if (query.actor_id) add('actor_id = ?', query.actor_id);
      if (query.action) add('action like ?', `${query.action}%`);
      if (query.since) add('occurred_at >= ?', query.since);
      if (query.until) add('occurred_at < ?', query.until);
      const cursor = decodeCursor(query.cursor);
      if (cursor) add('seq < ?', Number(cursor.id));
      params.push(query.limit + 1);
      const rows = await tx((t) =>
        t.many(
          `select a.*, u.display_name as actor_name
             from audit_events a
             left join users u on a.actor_type = 'user' and u.id::text = a.actor_id
            ${where.length ? `where ${where.join(' and ')}` : ''}
            order by seq desc limit $${params.length}`,
          params,
        ),
      );
      const hasMore = rows.length > query.limit;
      const items = hasMore ? rows.slice(0, query.limit) : rows;
      const last = items[items.length - 1];
      return {
        items,
        next_cursor:
          hasMore && last
            ? Buffer.from(JSON.stringify([last.occurred_at, String(last.seq)])).toString('base64url')
            : null,
      };
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/audit/verify',
    summary: 'Verify the integrity of the tenant audit hash chain',
    tags: ['audit'],
    permission: 'audit:read',
    scopes: ['audit:read'],
    handler: async ({ auth, tx }) => tx((t) => verifyAuditChain(t, auth.tenantId)),
  });
}
