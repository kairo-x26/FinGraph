import type { FastifyInstance, FastifyRequest } from 'fastify';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import { API_SCOPE_LIST, permissionsForScopes } from '@fingraph/shared';
import type { Config } from '../../config';
import type { AuthContext } from '../../context';
import type { Database } from '../../db';
import { deriveKey, randomToken, safeEqual, sha256Hex } from '../../lib/crypto';
import { notFound } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit } from '../audit/service';

const TOKEN_TTL_SEC = 900;
const AUDIENCE = 'fingraph-api';

const tokenKey = (config: Config) => deriveKey(config.APP_SECRET, 'api-access-token');

interface ClientRow {
  id: string;
  tenant_id: string;
  name: string;
  client_id: string;
  secret_hash: string;
  scopes: string[];
  revoked_at: Date | null;
}

/** Verifies a bearer access token issued by /oauth/token and loads the client. */
export async function resolveBearer(db: Database, config: Config, token: string): Promise<AuthContext | null> {
  try {
    const { payload } = await jwtVerify(token, tokenKey(config), { issuer: config.PUBLIC_API_URL, audience: AUDIENCE, algorithms: ['HS256'] });
    const client = await db.system((tx) =>
      tx.one<ClientRow & { tenant_status: string }>(
        `select c.*, t.status as tenant_status from api_clients c join tenants t on t.id = c.tenant_id
          where c.client_id = $1 and c.tenant_id = $2`,
        [payload.sub, payload.tid],
      ),
    );
    if (!client || client.revoked_at || client.tenant_status !== 'active') return null;
    const scopes = String(payload.scope ?? '').split(' ').filter((s) => client.scopes.includes(s));
    return {
      kind: 'api_client',
      tenantId: client.tenant_id,
      userId: null,
      clientId: client.client_id,
      email: null,
      displayName: client.name,
      roles: [],
      permissions: permissionsForScopes(scopes),
      sessionId: null,
      csrfToken: null,
      scopes,
    };
  } catch {
    return null;
  }
}

function clientCredentials(req: FastifyRequest) {
  const body = (req.body ?? {}) as Record<string, string>;
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const [id, secret] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    return { id: decodeURIComponent(id ?? ''), secret: decodeURIComponent(secret ?? '') };
  }
  return { id: body.client_id ?? '', secret: body.client_secret ?? '' };
}

export async function apiClientRoutes(app: FastifyInstance) {
  const { db, config } = app.ctx;

  app.post('/oauth/token', { config: { rateLimit: { max: 60, windowMs: 60_000 } }, schema: { summary: 'OAuth 2.0 client credentials token endpoint', tags: ['auth'] } }, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const oauthError = (status: number, error: string, description: string) =>
      reply.code(status).header('cache-control', 'no-store').send({ error, error_description: description });
    if (body.grant_type !== 'client_credentials') return oauthError(400, 'unsupported_grant_type', 'Only client_credentials is supported');
    const { id, secret } = clientCredentials(req);
    const client = await db.system((tx) => tx.one<ClientRow>('select * from api_clients where client_id = $1', [id]));
    if (!client || client.revoked_at || !safeEqual(client.secret_hash, sha256Hex(secret))) {
      return oauthError(401, 'invalid_client', 'Client authentication failed');
    }
    const requested = body.scope ? body.scope.split(' ').filter(Boolean) : client.scopes;
    if (requested.some((s) => !client.scopes.includes(s))) return oauthError(400, 'invalid_scope', 'Requested scope exceeds the client grant');
    const token = await new SignJWT({ tid: client.tenant_id, scope: requested.join(' ') })
      .setProtectedHeader({ alg: 'HS256', typ: 'at+jwt' })
      .setIssuer(config.PUBLIC_API_URL)
      .setAudience(AUDIENCE)
      .setSubject(client.client_id)
      .setJti(randomToken(12))
      .setIssuedAt()
      .setExpirationTime(`${TOKEN_TTL_SEC}s`)
      .sign(tokenKey(config));
    await db.tenant(client.tenant_id, (tx) => tx.query('update api_clients set last_used_at = now() where id = $1', [client.id]));
    return reply.header('cache-control', 'no-store').send({ access_token: token, token_type: 'Bearer', expires_in: TOKEN_TTL_SEC, scope: requested.join(' ') });
  });

  route(app, {
    method: 'POST',
    url: '/v1/api-clients',
    summary: 'Create an API client (the secret is shown once)',
    tags: ['developers'],
    permission: 'api_client:manage',
    status: 201,
    body: z.object({ name: z.string().trim().min(2).max(100), scopes: z.array(z.enum(API_SCOPE_LIST as [string, ...string[]])).min(1) }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const clientId = `fgc_${randomToken(12)}`;
        const secret = `fgs_${randomToken(32)}`;
        const row = await t.one(
          `insert into api_clients (tenant_id, name, client_id, secret_hash, scopes, created_by) values ($1,$2,$3,$4,$5,$6)
           returning id, name, client_id, scopes, created_at`,
          [auth.tenantId, body.name, clientId, sha256Hex(secret), [...new Set(body.scopes)], auth.userId],
        );
        await audit(t, req, { action: 'api_client.created', resourceType: 'api_client', resourceId: row!.id, details: { name: body.name, scopes: body.scopes } });
        return { ...row, client_secret: secret, token_url: `${config.PUBLIC_API_URL}/oauth/token` };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/api-clients',
    summary: 'API clients',
    tags: ['developers'],
    permission: 'api_client:manage',
    handler: async ({ tx }) => ({
      items: await tx((t) =>
        t.many(
          `select c.id, c.name, c.client_id, c.scopes, c.last_used_at, c.revoked_at, c.created_at, u.display_name as created_by_name
             from api_clients c left join users u on u.id = c.created_by order by c.created_at desc`,
        ),
      ),
      available_scopes: API_SCOPE_LIST,
    }),
  });

  route(app, {
    method: 'DELETE',
    url: '/v1/api-clients/:id',
    summary: 'Revoke an API client; its tokens stop working immediately',
    tags: ['developers'],
    permission: 'api_client:manage',
    params: uuidParam,
    handler: async ({ params, req, tx }) =>
      tx(async (t) => {
        const r = await t.query('update api_clients set revoked_at = now() where id = $1 and revoked_at is null', [params.id]);
        if (!r.rowCount) throw notFound('API client');
        await audit(t, req, { action: 'api_client.revoked', resourceType: 'api_client', resourceId: params.id });
      }),
  });
}
