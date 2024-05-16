import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import type { AppContext, AuthContext, ServiceOverrides } from './context';
import { createContext } from './services';
import { createWorker } from './jobs';
import type { Worker } from './modules/jobs/worker';
import { documentRoutes } from './modules/documents/routes';
import type { Config } from './config';
import type { Database } from './db';
import { AppError } from './lib/errors';
import { auditRoutes } from './modules/audit/routes';
import { caseRoutes } from './modules/cases/routes';
import { healthRoutes } from './modules/health/routes';
import { adminRoutes } from './modules/identity/admin-routes';
import { authRoutes, identityHooks } from './modules/identity/auth-routes';
import { scimRoutes } from './modules/identity/scim';
import { registerRateLimit } from './lib/rate-limit';

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
    worker: Worker;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
  interface FastifyContextConfig {
    rateLimit?: { max: number; windowMs: number };
    scopes?: string[];
    rawBody?: boolean;
  }
}

const CORRELATION_RE = /^[A-Za-z0-9._-]{8,128}$/;

export interface BuildOptions {
  config: Config;
  db: Database;
  services?: ServiceOverrides;
}

export async function buildApp({ config, db, services }: BuildOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["x-csrf-token"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
    },
    genReqId: (req) => {
      const incoming = req.headers['x-correlation-id'];
      return typeof incoming === 'string' && CORRELATION_RE.test(incoming) ? incoming : randomUUID();
    },
    requestIdHeader: false,
    trustProxy: true,
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { strict: false } },
  });

  // zod does the validation; JSON schemas are only used for documentation.
  app.setValidatorCompiler(() => (data) => ({ value: data }));
  app.setSerializerCompiler(() => (data) => JSON.stringify(data));

  const ctx: AppContext = createContext(config, db, app.log, services);
  app.decorate('ctx', ctx);
  // The worker is always constructed (tests drain it); it only polls when WORKER_INLINE is set.
  const worker = createWorker(ctx);
  app.decorate('worker', worker);
  if (config.WORKER_INLINE) {
    app.addHook('onReady', async () => worker.start());
  }
  app.addHook('onClose', async () => worker.stop());
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('cache-control', reply.getHeader('cache-control') ?? 'no-store');
  });

  app.setErrorHandler((err: FastifyError | AppError, req, reply) => {
    if (err instanceof AppError) {
      if (err.status >= 500) req.log.error({ err }, 'request failed');
      return reply
        .code(err.status)
        .type('application/problem+json')
        .send({
          type: `https://docs.fingraph.dev/errors/${err.code}`,
          title: err.message,
          status: err.status,
          code: err.code,
          correlation_id: req.id,
          ...err.extra,
        });
    }
    const status = typeof err.statusCode === 'number' && err.statusCode >= 400 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply
      .code(status)
      .type('application/problem+json')
      .send({
        type: 'about:blank',
        title: status >= 500 ? 'Internal server error.' : err.message,
        status,
        code: status >= 500 ? 'internal_error' : (err.code ?? 'bad_request').toLowerCase(),
        correlation_id: req.id,
      });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).type('application/problem+json').send({
      type: 'https://docs.fingraph.dev/errors/not_found',
      title: 'Route not found.',
      status: 404,
      code: 'not_found',
      correlation_id: req.id,
    });
  });

  await app.register(cookie, { secret: config.APP_SECRET });
  await app.register(cors, {
    origin: [config.WEB_URL],
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'x-csrf-token', 'idempotency-key', 'x-correlation-id'],
    exposedHeaders: ['x-correlation-id', 'retry-after'],
  });

  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'FinGraph API',
        version: '1.0.0',
        description:
          'Document intelligence and compliance evidence API. All resources are tenant scoped; ' +
          'a known identifier is never evidence of permission.',
      },
      servers: [{ url: config.PUBLIC_API_URL }],
      components: {
        securitySchemes: {
          session: { type: 'apiKey', in: 'cookie', name: 'fg_session' },
          bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
      security: [{ session: [] }, { bearer: [] }],
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await identityHooks(app);
  registerRateLimit(app, config.RATE_LIMIT_PER_MINUTE);

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(adminRoutes);
  await app.register(scimRoutes);
  await app.register(auditRoutes);
  await app.register(caseRoutes);
  await app.register(documentRoutes);

  return app;
}
