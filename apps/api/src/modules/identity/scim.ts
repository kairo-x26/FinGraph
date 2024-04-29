import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isRole, type Role } from '@fingraph/shared';
import type { Tx } from '../../db';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { notFound } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit, recordAudit } from '../audit/service';
import { revokeUserSessions } from './sessions';

/**
 * Minimal SCIM 2.0 Users endpoint (RFC 7643/7644) for enterprise provisioning.
 * Authenticated with a per-tenant bearer token; FinGraph roles map to SCIM `roles`.
 */

const SCIM_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const SCIM_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const SCIM_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const SCIM_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  roles: string[];
  status: string;
  external_id: string | null;
  created_at: Date;
  updated_at: Date;
}

function toScim(u: UserRow, base: string) {
  return {
    schemas: [SCIM_USER],
    id: u.id,
    externalId: u.external_id ?? undefined,
    userName: u.email,
    displayName: u.display_name,
    emails: [{ value: u.email, primary: true }],
    active: u.status === 'active' || u.status === 'invited',
    roles: u.roles.map((r) => ({ value: r })),
    meta: {
      resourceType: 'User',
      created: u.created_at,
      lastModified: u.updated_at,
      location: `${base}/scim/v2/Users/${u.id}`,
    },
  };
}

function scimError(reply: FastifyReply, status: number, detail: string, scimType?: string) {
  return reply.code(status).type('application/scim+json').send({ schemas: [SCIM_ERROR], status: String(status), detail, scimType });
}

const scimUserBody = z.object({
  userName: z.email(),
  externalId: z.string().max(200).optional(),
  displayName: z.string().max(120).optional(),
  name: z.object({ givenName: z.string().optional(), familyName: z.string().optional() }).optional(),
  active: z.boolean().default(true),
  roles: z.array(z.object({ value: z.string() })).optional(),
});

function rolesFrom(input: { value: string }[] | undefined): Role[] {
  const roles = (input ?? []).map((r) => r.value).filter(isRole);
  return roles.length ? roles : ['analyst'];
}

export async function scimRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx;
  const base = config.PUBLIC_API_URL;

  async function authenticate(req: FastifyRequest): Promise<{ tenantId: string; tokenId: string } | null> {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) return null;
    const row = await db.system((tx) =>
      tx.one<{ id: string; tenant_id: string }>(
        `update provisioning_tokens set last_used_at = now()
          where token_hash = $1 and revoked_at is null returning id, tenant_id`,
        [sha256Hex(header.slice(7))],
      ),
    );
    return row ? { tenantId: row.tenant_id, tokenId: row.id } : null;
  }

  const actor = (tokenId: string) => ({ type: 'system' as const, id: `scim:${tokenId}` });

  async function setActive(tx: Tx, tenantId: string, tokenId: string, id: string, active: boolean, reqId: string) {
    await tx.query(
      `update users set status = $2, deactivated_at = case when $2 = 'deactivated' then now() else null end where id = $1`,
      [id, active ? 'active' : 'deactivated'],
    );
    if (!active) await revokeUserSessions(tx, id);
    await recordAudit(tx, {
      tenantId,
      actor: actor(tokenId),
      action: active ? 'user.reactivated' : 'user.deactivated',
      resourceType: 'user',
      resourceId: id,
      correlationId: reqId,
      details: { via: 'scim' },
    });
  }

  await app.register(async (scim) => {
    scim.addContentTypeParser('application/scim+json', { parseAs: 'string' }, (_req, body, done) => {
      if (!body) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch {
        done(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 }), undefined);
      }
    });

    scim.addHook('preHandler', async (req, reply) => {
      const principal = await authenticate(req);
      if (!principal) return scimError(reply, 401, 'Invalid provisioning token');
      (req as FastifyRequest & { scim: typeof principal }).scim = principal;
    });

    const principalOf = (req: FastifyRequest) => (req as FastifyRequest & { scim: { tenantId: string; tokenId: string } }).scim;

    scim.get('/scim/v2/Users', async (req) => {
      const { tenantId } = principalOf(req);
      const q = req.query as { filter?: string; startIndex?: string; count?: string };
      const start = Math.max(1, Number(q.startIndex ?? 1));
      const count = Math.min(200, Math.max(0, Number(q.count ?? 100)));
      const m = q.filter?.match(/^userName eq "([^"]+)"$/i);
      const rows = await db.tenant(tenantId, (tx) =>
        m
          ? tx.many<UserRow>('select * from users where lower(email) = lower($1)', [m[1]])
          : tx.many<UserRow>('select * from users order by created_at offset $1 limit $2', [start - 1, count]),
      );
      const total = m
        ? rows.length
        : (await db.tenant(tenantId, (tx) => tx.one<{ n: number }>('select count(*)::int as n from users')))!.n;
      return {
        schemas: [SCIM_LIST],
        totalResults: total,
        startIndex: start,
        itemsPerPage: rows.length,
        Resources: rows.map((u) => toScim(u, base)),
      };
    });

    scim.get('/scim/v2/Users/:id', async (req, reply) => {
      const { tenantId } = principalOf(req);
      const { id } = req.params as { id: string };
      if (!uuidParam.safeParse({ id }).success) return scimError(reply, 404, 'User not found');
      const u = await db.tenant(tenantId, (tx) => tx.one<UserRow>('select * from users where id = $1', [id]));
      if (!u) return scimError(reply, 404, 'User not found');
      return toScim(u, base);
    });

    scim.post('/scim/v2/Users', async (req, reply) => {
      const { tenantId, tokenId } = principalOf(req);
      const parsed = scimUserBody.safeParse(req.body);
      if (!parsed.success) return scimError(reply, 400, parsed.error.issues[0]!.message, 'invalidValue');
      const b = parsed.data;
      const name =
        b.displayName ?? ([b.name?.givenName, b.name?.familyName].filter(Boolean).join(' ') || b.userName);
      const result = await db.tenant(tenantId, async (tx) => {
        const dupe = await tx.one('select id from users where lower(email) = lower($1)', [b.userName]);
        if (dupe) return null;
        const u = await tx.one<UserRow>(
          `insert into users (tenant_id, email, display_name, roles, status, external_id)
           values ($1, lower($2), $3, $4, $5, $6) returning *`,
          [tenantId, b.userName, name, rolesFrom(b.roles), b.active ? 'active' : 'deactivated', b.externalId ?? null],
        );
        await recordAudit(tx, {
          tenantId,
          actor: actor(tokenId),
          action: 'user.provisioned',
          resourceType: 'user',
          resourceId: u!.id,
          correlationId: req.id,
          details: { email: u!.email, roles: u!.roles },
        });
        return u;
      });
      if (!result) return scimError(reply, 409, 'User already exists', 'uniqueness');
      return reply.code(201).type('application/scim+json').send(toScim(result, base));
    });

    scim.patch('/scim/v2/Users/:id', async (req, reply) => {
      const { tenantId, tokenId } = principalOf(req);
      const { id } = req.params as { id: string };
      const body = req.body as { schemas?: string[]; Operations?: { op: string; path?: string; value?: unknown }[] };
      if (!body?.schemas?.includes(SCIM_PATCH) || !Array.isArray(body.Operations)) {
        return scimError(reply, 400, 'Expected a PatchOp request', 'invalidSyntax');
      }
      if (!uuidParam.safeParse({ id }).success) return scimError(reply, 404, 'User not found');
      const updated = await db.tenant(tenantId, async (tx) => {
        const u = await tx.one<UserRow>('select * from users where id = $1', [id]);
        if (!u) return null;
        for (const op of body.Operations!) {
          const kind = op.op.toLowerCase();
          if (kind !== 'replace' && kind !== 'add') continue;
          // Okta/Azure send either {path: 'active', value} or {value: {active}}
          const values: Record<string, unknown> = op.path ? { [op.path]: op.value } : ((op.value ?? {}) as Record<string, unknown>);
          if ('active' in values) await setActive(tx, tenantId, tokenId, id, Boolean(values.active), req.id);
          if ('displayName' in values && typeof values.displayName === 'string') {
            await tx.query('update users set display_name = $2 where id = $1', [id, values.displayName.slice(0, 120)]);
          }
          if ('roles' in values && Array.isArray(values.roles)) {
            const roles = rolesFrom(values.roles as { value: string }[]);
            await tx.query('update users set roles = $2 where id = $1', [id, roles]);
            await recordAudit(tx, {
              tenantId,
              actor: actor(tokenId),
              action: 'user.updated',
              resourceType: 'user',
              resourceId: id,
              correlationId: req.id,
              details: { roles, via: 'scim' },
            });
          }
        }
        return tx.one<UserRow>('select * from users where id = $1', [id]);
      });
      if (!updated) return scimError(reply, 404, 'User not found');
      return reply.type('application/scim+json').send(toScim(updated, base));
    });

    scim.delete('/scim/v2/Users/:id', async (req, reply) => {
      const { tenantId, tokenId } = principalOf(req);
      const { id } = req.params as { id: string };
      if (!uuidParam.safeParse({ id }).success) return scimError(reply, 404, 'User not found');
      // Users are deactivated rather than deleted so audit history keeps its actors.
      const ok = await db.tenant(tenantId, async (tx) => {
        const u = await tx.one('select id from users where id = $1', [id]);
        if (!u) return false;
        await setActive(tx, tenantId, tokenId, id, false, req.id);
        return true;
      });
      if (!ok) return scimError(reply, 404, 'User not found');
      return reply.code(204).send();
    });
  });

  // Token management for administrators.
  route(app, {
    method: 'POST',
    url: '/v1/tenant/provisioning-tokens',
    summary: 'Create a SCIM provisioning token (shown once)',
    tags: ['admin'],
    permission: 'admin:users',
    status: 201,
    body: z.object({ name: z.string().min(1).max(100) }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const token = `fgscim_${randomToken(32)}`;
        const row = await t.one<{ id: string }>(
          `insert into provisioning_tokens (tenant_id, name, token_hash, created_by) values ($1, $2, $3, $4)
           returning id, name, created_at`,
          [auth.tenantId, body.name, sha256Hex(token), auth.userId],
        );
        await audit(t, req, { action: 'provisioning_token.created', resourceType: 'provisioning_token', resourceId: row!.id });
        return { ...row, token, scim_base_url: `${base}/scim/v2` };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/tenant/provisioning-tokens',
    summary: 'List SCIM provisioning tokens',
    tags: ['admin'],
    permission: 'admin:users',
    handler: async ({ tx }) => ({
      items: await tx((t) =>
        t.many('select id, name, last_used_at, revoked_at, created_at from provisioning_tokens order by created_at desc'),
      ),
    }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/tenant/provisioning-tokens/:id',
    summary: 'Revoke a SCIM provisioning token',
    tags: ['admin'],
    permission: 'admin:users',
    params: uuidParam,
    handler: async ({ params, req, tx }) =>
      tx(async (t) => {
        const r = await t.query('update provisioning_tokens set revoked_at = now() where id = $1 and revoked_at is null', [params.id]);
        if (!r.rowCount) throw notFound('Token');
        await audit(t, req, { action: 'provisioning_token.revoked', resourceType: 'provisioning_token', resourceId: params.id });
      }),
  });
}
