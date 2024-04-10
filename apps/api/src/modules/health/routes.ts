import type { FastifyInstance } from 'fastify';
import { route } from '../../lib/http';

export async function healthRoutes(app: FastifyInstance) {
  route(app, {
    method: 'GET',
    url: '/healthz',
    summary: 'Liveness probe',
    tags: ['health'],
    auth: 'none',
    handler: async () => ({ status: 'ok' }),
  });

  route(app, {
    method: 'GET',
    url: '/readyz',
    summary: 'Readiness probe (checks the database)',
    tags: ['health'],
    auth: 'none',
    handler: async ({ reply }) => {
      try {
        await app.ctx.db.system((tx) => tx.query('select 1'));
        return { status: 'ready', database: 'ok' };
      } catch {
        reply.code(503);
        return { status: 'unavailable', database: 'error' };
      }
    },
  });
}
