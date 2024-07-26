import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { notFound } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';

export async function notificationRoutes(app: FastifyInstance) {
  route(app, {
    method: 'GET',
    url: '/v1/notifications',
    summary: 'Your notifications, newest first',
    tags: ['notifications'],
    query: z.object({ unread: z.enum(['true', 'false']).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) }),
    handler: async ({ query, auth, tx }) =>
      tx(async (t) => {
        const items = await t.many(
          `select * from notifications where user_id = $1 ${query.unread === 'true' ? 'and read_at is null' : ''}
            order by created_at desc limit $2`,
          [auth.userId, query.limit],
        );
        const unread = await t.one<{ n: number }>('select count(*)::int as n from notifications where user_id = $1 and read_at is null', [auth.userId]);
        return { items, unread: unread!.n };
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/notifications/:id/read',
    summary: 'Mark a notification as read',
    tags: ['notifications'],
    params: uuidParam,
    handler: async ({ params, auth, tx }) =>
      tx(async (t) => {
        const r = await t.one('update notifications set read_at = coalesce(read_at, now()) where id = $1 and user_id = $2 returning *', [params.id, auth.userId]);
        if (!r) throw notFound('Notification');
        return r;
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/notifications/read-all',
    summary: 'Mark all notifications as read',
    tags: ['notifications'],
    handler: async ({ auth, tx }) =>
      tx(async (t) => {
        const r = await t.query('update notifications set read_at = now() where user_id = $1 and read_at is null', [auth.userId]);
        return { updated: r.rowCount };
      }),
  });
}
