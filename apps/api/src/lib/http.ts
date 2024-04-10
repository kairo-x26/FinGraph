import type { FastifyInstance, FastifyReply, FastifyRequest, HTTPMethods } from 'fastify';
import { z, type ZodType } from 'zod';
import type { Permission } from '@fingraph/shared';
import type { AuthContext } from '../context';
import type { Tx } from '../db';
import { forbidden, unauthenticated, validationError } from './errors';

export interface HandlerArgs<B, Q, P> {
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  auth: AuthContext;
  /** Runs `fn` in a tenant-scoped transaction for the caller's tenant. */
  tx: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
}

export interface PublicHandlerArgs<B, Q, P> {
  req: FastifyRequest;
  reply: FastifyReply;
  body: B;
  query: Q;
  params: P;
  auth: AuthContext | null;
}

interface BaseSpec<B, Q, P> {
  method: HTTPMethods;
  url: string;
  summary: string;
  tags?: string[];
  body?: ZodType<B>;
  query?: ZodType<Q>;
  params?: ZodType<P>;
  /** Default success status code. */
  status?: number;
  /** Extra OpenAPI response documentation. */
  responses?: Record<number, { description: string }>;
  /** Raw body handling (e.g. binary uploads): skip JSON body parsing. */
  rawBody?: boolean;
  /** API client OAuth scopes accepted for this route (users are checked by permission). */
  scopes?: string[];
  rateLimit?: { max: number; windowMs: number };
}

export interface AuthedSpec<B, Q, P> extends BaseSpec<B, Q, P> {
  auth?: 'required';
  /** All listed permissions are required. */
  permission?: Permission | Permission[];
  handler: (args: HandlerArgs<B, Q, P>) => Promise<unknown>;
}

export interface PublicSpec<B, Q, P> extends BaseSpec<B, Q, P> {
  auth: 'none' | 'optional';
  handler: (args: PublicHandlerArgs<B, Q, P>) => Promise<unknown>;
}

function parse<T>(schema: ZodType<T> | undefined, value: unknown, where: string): T {
  if (!schema) return value as T;
  const r = schema.safeParse(value ?? (where === 'body' ? undefined : {}));
  if (!r.success) {
    throw validationError(
      r.error.issues.map((i) => ({
        path: [where, ...i.path.map(String)].join('.'),
        message: i.message,
      })),
    );
  }
  return r.data;
}

function jsonSchema(schema: ZodType | undefined) {
  if (!schema) return undefined;
  try {
    const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;
    return rest;
  } catch {
    return undefined;
  }
}

export function hasPermissions(auth: AuthContext, required: Permission[]): boolean {
  return required.every((p) => auth.permissions.has(p));
}

export function assertPermission(auth: AuthContext, ...required: Permission[]) {
  if (!hasPermissions(auth, required)) throw forbidden();
}

/**
 * Registers a route with zod validation, authentication, permission checks and
 * OpenAPI metadata in one place. Tenant scoping is applied through `tx`.
 */
export function route<B = unknown, Q = unknown, P = unknown>(
  app: FastifyInstance,
  spec: AuthedSpec<B, Q, P> | PublicSpec<B, Q, P>,
) {
  const required: Permission[] =
    'permission' in spec && spec.permission
      ? Array.isArray(spec.permission)
        ? spec.permission
        : [spec.permission]
      : [];

  app.route({
    method: spec.method,
    url: spec.url,
    config: { rateLimit: spec.rateLimit, scopes: spec.scopes, rawBody: spec.rawBody },
    schema: Object.fromEntries(
      Object.entries({
        summary: spec.summary,
        tags: spec.tags,
        body: spec.rawBody ? undefined : jsonSchema(spec.body),
        querystring: jsonSchema(spec.query),
        params: jsonSchema(spec.params),
        security: spec.auth === 'none' ? [] : undefined,
      }).filter(([, v]) => v !== undefined),
    ),
    handler: async (req, reply) => {
      const auth = req.auth ?? null;
      const params = parse(spec.params, req.params, 'params');
      const query = parse(spec.query, req.query, 'query');
      const body = spec.rawBody ? (req.body as B) : parse(spec.body, req.body, 'body');

      let result: unknown;
      if (spec.auth === 'none' || spec.auth === 'optional') {
        result = await spec.handler({ req, reply, body, query, params, auth });
      } else {
        if (!auth) throw unauthenticated();
        if (auth.kind === 'api_client') {
          const accepted = spec.scopes ?? [];
          if (!accepted.some((s) => auth.scopes.includes(s))) throw forbidden();
        }
        if (!hasPermissions(auth, required)) throw forbidden();
        const tx = <T>(fn: (tx: Tx) => Promise<T>) => req.server.ctx.db.tenant(auth.tenantId, fn);
        result = await spec.handler({ req, reply, body, query, params, auth, tx });
      }

      if (reply.sent) return reply;
      if (result === undefined) return reply.code(spec.status ?? 204).send();
      return reply.code(spec.status ?? 200).send(result);
    },
  });
}

export const uuidParam = z.object({ id: z.uuid() });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

/** Opaque keyset cursor over (created_at, id). */
export function encodeCursor(createdAt: Date | string, id: string): string {
  const t = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return Buffer.from(JSON.stringify([t, id])).toString('base64url');
}

export function decodeCursor(cursor: string | undefined): { createdAt: string; id: string } | null {
  if (!cursor) return null;
  try {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function page<T extends { created_at: Date | string; id: string }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}
