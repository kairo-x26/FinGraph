import type { FastifyInstance } from 'fastify';
import { tooManyRequests } from './errors';

export interface RateLimitStore {
  /** Increments the counter for `key` in the current window and returns the new count. */
  hit(key: string, windowMs: number): Promise<{ count: number; resetAt: number }>;
}

/** Fixed-window in-memory store. Suitable for a single API instance; use Redis when scaling out. */
export class MemoryRateLimitStore implements RateLimitStore {
  private buckets = new Map<string, { count: number; resetAt: number }>();

  async hit(key: string, windowMs: number) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
      if (this.buckets.size > 50_000) this.sweep(now);
    }
    b.count++;
    return { ...b };
  }

  private sweep(now: number) {
    for (const [k, v] of this.buckets) if (v.resetAt <= now) this.buckets.delete(k);
  }
}

/**
 * Applies a per-principal default limit to every request plus stricter per-route
 * limits declared with `config.rateLimit`. Runs after authentication so limits
 * follow the tenant/user rather than only the IP address.
 */
export function registerRateLimit(app: FastifyInstance, perMinute: number, store: RateLimitStore = new MemoryRateLimitStore()) {
  app.addHook('preHandler', async (req, reply) => {
    if (req.url === '/healthz' || req.url === '/readyz') return;
    const principal = req.auth
      ? `${req.auth.tenantId}:${req.auth.userId ?? req.auth.clientId}`
      : `ip:${req.ip}`;
    const checks: { key: string; max: number; windowMs: number }[] = [
      { key: `g:${principal}`, max: perMinute, windowMs: 60_000 },
    ];
    const routeLimit = req.routeOptions.config?.rateLimit;
    if (routeLimit) {
      checks.push({ key: `r:${req.routeOptions.url}:${principal}`, max: routeLimit.max, windowMs: routeLimit.windowMs });
    }
    for (const c of checks) {
      const { count, resetAt } = await store.hit(c.key, c.windowMs);
      if (count > c.max) {
        reply.header('retry-after', Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
        throw tooManyRequests();
      }
    }
  });
}
