import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ROLE_LABELS } from '@fingraph/shared';
import { randomToken, safeEqual, sha256Hex } from '../../lib/crypto';
import { route } from '../../lib/http';
import { recordAudit } from '../audit/service';
import { resolveBearer } from '../integrations/api-clients';
import { hasMfa, OidcClient, OidcError, pkcePair } from './oidc';
import {
  createSession,
  CSRF_COOKIE,
  resolveSession,
  revokeSession,
  SESSION_COOKIE,
} from './sessions';
import { ipAllowed, oidcProviderFor, settingsOf, tenantBySlug, type TenantRow } from './tenants';

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FLOW_TTL_MS = 10 * 60_000;

/** Only same-origin relative paths are allowed as post-login destinations. */
export function safeRedirectPath(value: string | undefined): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/';
  return value.slice(0, 500);
}

export async function identityHooks(app: FastifyInstance) {
  const { config, db } = app.ctx;

  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ') && !req.url.startsWith('/scim/')) {
      req.auth = await resolveBearer(db, config, header.slice(7));
      return;
    }
    const token = req.cookies[SESSION_COOKIE];
    if (token) req.auth = await resolveSession(db, config, token, req.ip);
  });

  // Double-submit CSRF protection for cookie-authenticated, state-changing requests.
  app.addHook('preHandler', async (req, reply) => {
    if (!UNSAFE.has(req.method) || req.auth?.kind !== 'user' || !req.auth.csrfToken) return;
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || !safeEqual(header, req.auth.csrfToken)) {
      return reply.code(403).type('application/problem+json').send({
        type: 'https://docs.fingraph.dev/errors/csrf_failed',
        title: 'Missing or invalid CSRF token.',
        status: 403,
        code: 'csrf_failed',
        correlation_id: req.id,
      });
    }
  });
}

export async function authRoutes(app: FastifyInstance) {
  const { config, db } = app.ctx;
  const oidc = new OidcClient();
  const callbackUrl = `${config.PUBLIC_API_URL}/v1/auth/callback`;

  const failLogin = (reply: FastifyReply, code: string) =>
    reply.redirect(`${config.WEB_URL}/login?error=${encodeURIComponent(code)}`, 302);

  route(app, {
    method: 'GET',
    url: '/v1/auth/login',
    summary: 'Start OpenID Connect sign-in for an organization',
    tags: ['auth'],
    auth: 'none',
    query: z.object({
      tenant: z.string().min(3).max(50),
      redirect_to: z.string().max(500).optional(),
      login_hint: z.email().optional(),
    }),
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async ({ query, reply }) => {
      const tenant = await db.system((tx) => tenantBySlug(tx, query.tenant.toLowerCase()));
      if (!tenant || tenant.status !== 'active') return failLogin(reply, 'unknown_organization');
      const provider = oidcProviderFor(config, tenant);
      const state = randomToken(24);
      const nonce = randomToken(24);
      const { verifier, challenge } = pkcePair();
      await db.system((tx) =>
        tx.query(
          `insert into auth_flows (state, tenant_id, nonce, code_verifier, redirect_to, issuer)
           values ($1, $2, $3, $4, $5, $6)`,
          [state, tenant.id, nonce, verifier, safeRedirectPath(query.redirect_to), provider.issuer],
        ),
      );
      try {
        const url = await oidc.authorizationUrl(provider, {
          redirectUri: callbackUrl,
          state,
          nonce,
          codeChallenge: challenge,
          loginHint: query.login_hint,
        });
        return reply.redirect(url, 302);
      } catch (err) {
        app.log.warn({ err }, 'oidc discovery failed');
        return failLogin(reply, 'idp_unavailable');
      }
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/auth/callback',
    summary: 'OpenID Connect redirect endpoint',
    tags: ['auth'],
    auth: 'none',
    query: z.object({
      code: z.string().max(2000).optional(),
      state: z.string().max(200).optional(),
      iss: z.string().max(500).optional(),
      error: z.string().max(200).optional(),
    }),
    rateLimit: { max: 30, windowMs: 60_000 },
    handler: async ({ query, req, reply }) => {
      if (!query.state) return failLogin(reply, 'invalid_state');
      // Single use: consume the flow atomically.
      const flow = await db.system((tx) =>
        tx.one<{ tenant_id: string; nonce: string; code_verifier: string; redirect_to: string; issuer: string; created_at: Date }>(
          `update auth_flows set consumed_at = now()
            where state = $1 and consumed_at is null
            returning tenant_id, nonce, code_verifier, redirect_to, issuer, created_at`,
          [query.state],
        ),
      );
      if (!flow || Date.now() - new Date(flow.created_at).getTime() > FLOW_TTL_MS) {
        return failLogin(reply, 'invalid_state');
      }
      if (query.error) return failLogin(reply, query.error === 'access_denied' ? 'access_denied' : 'idp_error');
      if (!query.code) return failLogin(reply, 'idp_error');

      const tenant = await db.system((tx) =>
        tx.one<TenantRow>('select * from tenants where id = $1', [flow.tenant_id]),
      );
      if (!tenant) return failLogin(reply, 'unknown_organization');
      const provider = oidcProviderFor(config, tenant);
      if (provider.issuer !== flow.issuer) return failLogin(reply, 'invalid_state');

      let claims;
      try {
        claims = await oidc.completeLogin(provider, {
          code: query.code,
          redirectUri: callbackUrl,
          codeVerifier: flow.code_verifier,
          nonce: flow.nonce,
          iss: query.iss ?? null,
        });
      } catch (err) {
        const code = err instanceof OidcError ? err.code : 'idp_error';
        req.log.warn({ code, msg: (err as Error).message }, 'oidc login failed');
        return failLogin(reply, code);
      }

      const settings = settingsOf(tenant);
      const amr = claims.amr ?? [];

      const outcome = await db.tenant(tenant.id, async (tx) => {
        const fail = async (reason: string, userId: string | null = null) => {
          await recordAudit(tx, {
            tenantId: tenant.id,
            actor: { type: userId ? 'user' : 'system', id: userId },
            action: 'auth.login_failed',
            resourceType: 'user',
            resourceId: userId,
            correlationId: req.id,
            ip: req.ip,
            details: { reason, email: claims.email ?? null, issuer: provider.issuer },
          });
          return { error: reason } as const;
        };

        let user = await tx.one<{ id: string; status: string; email: string }>(
          'select id, status, email from users where idp_issuer = $1 and idp_subject = $2',
          [provider.issuer, claims.sub],
        );
        if (!user && claims.email) {
          // First sign-in of an invited or pre-provisioned user links the IdP identity.
          user = await tx.one(
            `update users set idp_issuer = $1, idp_subject = $2,
                    status = case when status = 'invited' then 'active' else status end
              where lower(email) = lower($3) and idp_subject is null
                and (status = 'active' or (status = 'invited' and exists (
                      select 1 from invitations i where i.tenant_id = users.tenant_id
                         and lower(i.email) = lower(users.email) and i.accepted_at is null
                         and i.revoked_at is null and i.expires_at > now())))
              returning id, status, email`,
            [provider.issuer, claims.sub, claims.email],
          );
          if (user) {
            await tx.query(
              `update invitations set accepted_at = now()
                where lower(email) = lower($1) and accepted_at is null and revoked_at is null`,
              [user.email],
            );
          }
        }
        if (!user) return fail('not_provisioned');
        if (user.status !== 'active') return fail('account_deactivated', user.id);
        if (settings.require_mfa && !hasMfa(amr)) return fail('mfa_required', user.id);
        if (!ipAllowed(settings.ip_allowlist, req.ip)) return fail('network_not_allowed', user.id);

        await tx.query('update users set last_login_at = now() where id = $1', [user.id]);
        const session = await createSession(tx, config, tenant, {
          tenantId: tenant.id,
          userId: user.id,
          amr,
          idpSessionId: claims.sid ?? null,
          ip: req.ip,
          userAgent: req.headers['user-agent'] ?? null,
        });
        await recordAudit(tx, {
          tenantId: tenant.id,
          actor: { type: 'user', id: user.id },
          action: 'auth.login',
          resourceType: 'session',
          resourceId: session.id,
          correlationId: req.id,
          ip: req.ip,
          details: { amr, issuer: provider.issuer },
        });
        return { session } as const;
      });

      if ('error' in outcome) return failLogin(reply, outcome.error!);
      const cookieBase = { path: '/', sameSite: 'lax' as const, secure: config.COOKIE_SECURE };
      reply.setCookie(SESSION_COOKIE, outcome.session.token, {
        ...cookieBase,
        httpOnly: true,
        expires: new Date(outcome.session.expiresAt),
      });
      reply.setCookie(CSRF_COOKIE, outcome.session.csrf, { ...cookieBase, httpOnly: false });
      return reply.redirect(`${config.WEB_URL}${flow.redirect_to}`, 302);
    },
  });

  route(app, {
    method: 'GET',
    url: '/v1/auth/session',
    summary: 'Current user, roles, permissions and CSRF token',
    tags: ['auth'],
    handler: async ({ auth, tx }) => {
      const tenant = await tx((t) => t.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]));
      return {
        user: {
          id: auth.userId,
          email: auth.email,
          display_name: auth.displayName,
          roles: auth.roles.map((r) => ({ id: r, label: ROLE_LABELS[r] })),
        },
        tenant: tenant ? { id: tenant.id, slug: tenant.slug, name: tenant.name } : null,
        permissions: [...auth.permissions].sort(),
        csrf_token: auth.csrfToken,
      };
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/auth/logout',
    summary: 'End the current session',
    tags: ['auth'],
    handler: async ({ auth, req, reply, tx }) => {
      const tenant = await tx(async (t) => {
        if (auth.sessionId) await revokeSession(t, auth.sessionId);
        await recordAudit(t, {
          tenantId: auth.tenantId,
          actor: { type: 'user', id: auth.userId },
          action: 'auth.logout',
          resourceType: 'session',
          resourceId: auth.sessionId,
          correlationId: req.id,
          ip: req.ip,
        });
        return t.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]);
      });
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      reply.clearCookie(CSRF_COOKIE, { path: '/' });
      const issuer = tenant ? oidcProviderFor(config, tenant).issuer : config.OIDC_ISSUER;
      return { logout_url: await oidc.endSessionUrl(issuer, `${config.WEB_URL}/login?signed_out=1`) };
    },
  });
}

export function hashInviteToken(token: string) {
  return sha256Hex(`invite:${token}`);
}
