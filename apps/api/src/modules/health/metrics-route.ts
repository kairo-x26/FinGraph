import type { FastifyInstance } from 'fastify';
import { safeEqual } from '../../lib/crypto';
import { metrics, renderMetrics } from '../../lib/metrics';

export async function metricsEndpoint(app: FastifyInstance) {
  const { config, db } = app.ctx;

  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    const labels = { method: req.method, route, status: `${Math.floor(reply.statusCode / 100)}xx` };
    metrics.httpRequests.inc(labels);
    metrics.httpDuration.observe({ method: req.method, route }, reply.elapsedTime / 1000);
  });

  app.get('/metrics', { schema: { hide: true } }, async (req, reply) => {
    const token = config.METRICS_TOKEN;
    const header = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (token ? !safeEqual(header, token) : config.NODE_ENV === 'production') return reply.code(404).send();
    const queue = await db.system((tx) =>
      tx.many<{ kind: string; status: string; n: number; oldest: number | null }>(
        `select kind, status, count(*)::int as n,
                extract(epoch from now() - min(run_at) filter (where status = 'queued'))::int as oldest
           from jobs where status in ('queued', 'running', 'dead') group by kind, status`,
      ),
    );
    const outbox = await db.system((tx) => tx.one<{ n: number }>('select count(*)::int as n from outbox_events where dispatched_at is null'));
    const gauges = [
      '# HELP fingraph_jobs_current Jobs by kind and state',
      '# TYPE fingraph_jobs_current gauge',
      ...queue.map((q) => `fingraph_jobs_current{kind="${q.kind}",status="${q.status}"} ${q.n}`),
      '# HELP fingraph_queue_oldest_seconds Age of the oldest runnable job',
      '# TYPE fingraph_queue_oldest_seconds gauge',
      ...queue.filter((q) => q.status === 'queued').map((q) => `fingraph_queue_oldest_seconds{kind="${q.kind}"} ${Math.max(0, q.oldest ?? 0)}`),
      '# HELP fingraph_outbox_pending Events waiting for dispatch',
      '# TYPE fingraph_outbox_pending gauge',
      `fingraph_outbox_pending ${outbox!.n}`,
    ].join('\n');
    return reply.header('content-type', 'text/plain; version=0.0.4').send(renderMetrics([gauges]));
  });
}
