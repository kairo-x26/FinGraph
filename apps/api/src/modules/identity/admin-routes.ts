import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ROLES } from '@fingraph/shared';
import { randomToken, safeEqual } from '../../lib/crypto';
import { conflict, forbidden, notFound, unprocessable } from '../../lib/errors';
import { route, uuidParam } from '../../lib/http';
import { audit, recordAudit } from '../audit/service';
import { hashInviteToken } from './auth-routes';
import { revokeUserSessions } from './sessions';
import {
  encryptIdpSecret,
  publicTenant,
  settingsOf,
  tenantSettingsSchema,
  type TenantRow,
} from './tenants';

const roleList = z.array(z.enum(ROLES)).min(1).max(ROLES.length);

const USER_COLUMNS = `id, email, display_name, roles, status, idp_issuer, last_login_at, deactivated_at, created_at`;

export async function adminRoutes(app: FastifyInstance) {
  const { config, db } = app.ctx;

  route(app, {
    method: 'GET',
    url: '/v1/users',
    summary: 'List users in the organization',
    tags: ['admin'],
    permission: 'admin:users',
    query: z.object({ status: z.enum(['invited', 'active', 'deactivated']).optional() }),
    handler: async ({ query, tx }) => ({
      items: await tx((t) =>
        t.many(
          `select ${USER_COLUMNS} from users ${query.status ? 'where status = $1' : ''} order by display_name`,
          query.status ? [query.status] : [],
        ),
      ),
    }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/users/directory',
    summary: 'Active colleagues (for assignment pickers)',
    tags: ['admin'],
    permission: 'case:read',
    handler: async ({ tx }) => ({
      items: await tx((t) =>
        t.many(`select id, display_name, roles from users where status = 'active' order by display_name`),
      ),
    }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/invitations',
    summary: 'Invite a user; they are activated on first SSO sign-in with the invited email',
    tags: ['admin'],
    permission: 'admin:users',
    status: 201,
    body: z.object({
      email: z.email().max(254),
      display_name: z.string().min(1).max(120),
      roles: roleList,
    }),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const tenant = (await t.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]))!;
        const domains = settingsOf(tenant).allowed_email_domains;
        const domain = body.email.split('@')[1]!.toLowerCase();
        if (domains.length && !domains.includes(domain)) {
          throw unprocessable('domain_not_allowed', `Email domain ${domain} is not allowed for this organization.`);
        }
        const existing = await t.one('select id, status from users where lower(email) = lower($1)', [body.email]);
        if (existing) throw conflict('A user with this email already exists.');
        const user = await t.one<{ id: string }>(
          `insert into users (tenant_id, email, display_name, roles, status)
           values ($1, lower($2), $3, $4, 'invited') returning ${USER_COLUMNS}`,
          [auth.tenantId, body.email, body.display_name, body.roles],
        );
        const token = randomToken(24);
        const invitation = await t.one<{ id: string; expires_at: Date }>(
          `insert into invitations (tenant_id, email, roles, token_hash, invited_by, expires_at)
           values ($1, lower($2), $3, $4, $5, now() + interval '7 days') returning id, expires_at`,
          [auth.tenantId, body.email, body.roles, hashInviteToken(token), auth.userId],
        );
        await audit(t, req, {
          action: 'user.invited',
          resourceType: 'user',
          resourceId: user!.id,
          details: { email: body.email, roles: body.roles },
        });
        const url = new URL('/login', config.WEB_URL);
        url.searchParams.set('tenant', tenant.slug);
        url.searchParams.set('login_hint', body.email.toLowerCase());
        url.searchParams.set('invite', token);
        return { user, invitation: { ...invitation, url: url.toString() } };
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/invitations',
    summary: 'List pending invitations',
    tags: ['admin'],
    permission: 'admin:users',
    handler: async ({ tx }) => ({
      items: await tx((t) =>
        t.many(
          `select id, email, roles, expires_at, created_at from invitations
            where accepted_at is null and revoked_at is null order by created_at desc`,
        ),
      ),
    }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/invitations/:id/revoke',
    summary: 'Revoke a pending invitation',
    tags: ['admin'],
    permission: 'admin:users',
    params: uuidParam,
    handler: async ({ params, req, tx }) =>
      tx(async (t) => {
        const inv = await t.one<{ email: string }>(
          `update invitations set revoked_at = now() where id = $1 and accepted_at is null and revoked_at is null
           returning email`,
          [params.id],
        );
        if (!inv) throw notFound('Invitation');
        await t.query(`delete from users where lower(email) = lower($1) and status = 'invited'`, [inv.email]);
        await audit(t, req, { action: 'user.invitation_revoked', resourceType: 'invitation', resourceId: params.id });
        return { id: params.id, revoked: true };
      }),
  });

  async function assertNotLastAdmin(t: Parameters<Parameters<typeof db.tenant>[1]>[0], userId: string) {
    const r = await t.one<{ n: number }>(
      `select count(*)::int as n from users where status = 'active' and 'admin' = any(roles) and id <> $1`,
      [userId],
    );
    if (!r || r.n === 0) throw conflict('The organization must keep at least one active administrator.');
  }

  route(app, {
    method: 'PATCH',
    url: '/v1/users/:id',
    summary: 'Change a user’s roles or display name',
    tags: ['admin'],
    permission: 'admin:users',
    params: uuidParam,
    body: z.object({ roles: roleList.optional(), display_name: z.string().min(1).max(120).optional() }),
    handler: async ({ params, body, req, tx }) =>
      tx(async (t) => {
        const before = await t.one<{ roles: string[]; display_name: string }>(
          'select roles, display_name from users where id = $1',
          [params.id],
        );
        if (!before) throw notFound('User');
        if (body.roles && before.roles.includes('admin') && !body.roles.includes('admin')) {
          await assertNotLastAdmin(t, params.id);
        }
        const user = await t.one(
          `update users set roles = coalesce($2, roles), display_name = coalesce($3, display_name)
            where id = $1 returning ${USER_COLUMNS}`,
          [params.id, body.roles ?? null, body.display_name ?? null],
        );
        // Role changes take effect immediately: existing sessions are re-evaluated per request.
        await audit(t, req, {
          action: 'user.updated',
          resourceType: 'user',
          resourceId: params.id,
          details: { before, after: body },
        });
        return user;
      }),
  });

  route(app, {
    method: 'POST',
    url: '/v1/users/:id/deactivate',
    summary: 'Deactivate a user and revoke their sessions',
    tags: ['admin'],
    permission: 'admin:users',
    params: uuidParam,
    handler: async ({ params, auth, req, tx }) => {
      if (params.id === auth.userId) throw forbidden('You cannot deactivate your own account.');
      return tx(async (t) => {
        const u = await t.one<{ roles: string[]; status: string }>('select roles, status from users where id = $1', [params.id]);
        if (!u) throw notFound('User');
        if (u.roles.includes('admin')) await assertNotLastAdmin(t, params.id);
        const user = await t.one(
          `update users set status = 'deactivated', deactivated_at = now() where id = $1 returning ${USER_COLUMNS}`,
          [params.id],
        );
        const revoked = await revokeUserSessions(t, params.id);
        await audit(t, req, {
          action: 'user.deactivated',
          resourceType: 'user',
          resourceId: params.id,
          details: { sessions_revoked: revoked },
        });
        return user;
      });
    },
  });

  route(app, {
    method: 'POST',
    url: '/v1/users/:id/reactivate',
    summary: 'Reactivate a deactivated user',
    tags: ['admin'],
    permission: 'admin:users',
    params: uuidParam,
    handler: async ({ params, req, tx }) =>
      tx(async (t) => {
        const user = await t.one(
          `update users set status = 'active', deactivated_at = null
            where id = $1 and status = 'deactivated' returning ${USER_COLUMNS}`,
          [params.id],
        );
        if (!user) throw notFound('User');
        await audit(t, req, { action: 'user.reactivated', resourceType: 'user', resourceId: params.id });
        return user;
      }),
  });

  route(app, {
    method: 'GET',
    url: '/v1/tenant',
    summary: 'Organization profile and settings',
    tags: ['admin'],
    permission: 'admin:settings',
    handler: async ({ auth, tx }) => {
      const t = await tx((q) => q.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]));
      return publicTenant(t!);
    },
  });

  route(app, {
    method: 'PATCH',
    url: '/v1/tenant/settings',
    summary: 'Update organization security and governance settings',
    tags: ['admin'],
    permission: 'admin:settings',
    body: tenantSettingsSchema.partial(),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const current = await t.one<TenantRow>('select * from tenants where id = $1', [auth.tenantId]);
        const merged = tenantSettingsSchema.parse({ ...settingsOf(current!), ...body });
        const updated = await t.one<TenantRow>(
          'update tenants set settings = $2 where id = $1 returning *',
          [auth.tenantId, JSON.stringify(merged)],
        );
        await audit(t, req, {
          action: 'tenant.settings_updated',
          resourceType: 'tenant',
          resourceId: auth.tenantId,
          details: { changes: body },
        });
        return publicTenant(updated!);
      }),
  });

  route(app, {
    method: 'PUT',
    url: '/v1/tenant/sso',
    summary: 'Configure the organization’s own OpenID Connect identity provider',
    tags: ['admin'],
    permission: 'admin:settings',
    body: z.union([
      z.object({ issuer: z.url(), client_id: z.string().min(1).max(200), client_secret: z.string().min(1).max(500) }),
      z.object({ issuer: z.null() }),
    ]),
    handler: async ({ body, auth, req, tx }) =>
      tx(async (t) => {
        const updated =
          body.issuer === null
            ? await t.one<TenantRow>(
                `update tenants set oidc_issuer = null, oidc_client_id = null, oidc_client_secret_enc = null
                  where id = $1 returning *`,
                [auth.tenantId],
              )
            : await t.one<TenantRow>(
                `update tenants set oidc_issuer = $2, oidc_client_id = $3, oidc_client_secret_enc = $4
                  where id = $1 returning *`,
                [
                  auth.tenantId,
                  body.issuer.replace(/\/$/, ''),
                  'client_id' in body ? body.client_id : null,
                  'client_secret' in body ? encryptIdpSecret(config, auth.tenantId, body.client_secret) : null,
                ],
              );
        await audit(t, req, {
          action: 'tenant.sso_updated',
          resourceType: 'tenant',
          resourceId: auth.tenantId,
          details: { issuer: body.issuer },
        });
        return publicTenant(updated!);
      }),
  });

  // Platform operator endpoint for organization onboarding (IAM-03).
  route(app, {
    method: 'POST',
    url: '/v1/organizations',
    summary: 'Create an organization with its first administrator (platform operators only)',
    tags: ['platform'],
    auth: 'none',
    status: 201,
    body: z.object({
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/),
      name: z.string().min(2).max(120),
      admin_email: z.email(),
      admin_name: z.string().min(1).max(120),
      settings: tenantSettingsSchema.partial().optional(),
    }),
    handler: async ({ body, req }) => {
      const token = req.headers['x-platform-token'];
      if (!config.PLATFORM_ADMIN_TOKEN || typeof token !== 'string' || !safeEqual(token, config.PLATFORM_ADMIN_TOKEN)) {
        throw forbidden();
      }
      return db.system(async (t) => {
        const exists = await t.one('select 1 from tenants where slug = $1', [body.slug]);
        if (exists) throw conflict('That organization slug is taken.');
        const tenant = await t.one<TenantRow>(
          'insert into tenants (slug, name, settings) values ($1, $2, $3) returning *',
          [body.slug, body.name, JSON.stringify(tenantSettingsSchema.parse(body.settings ?? {}))],
        );
        const admin = await t.one<{ id: string }>(
          `insert into users (tenant_id, email, display_name, roles, status)
           values ($1, lower($2), $3, '{admin}', 'active') returning id`,
          [tenant!.id, body.admin_email, body.admin_name],
        );
        await recordAudit(t, {
          tenantId: tenant!.id,
          actor: { type: 'system', id: 'platform' },
          action: 'tenant.created',
          resourceType: 'tenant',
          resourceId: tenant!.id,
          correlationId: req.id,
          ip: req.ip,
          details: { admin_user_id: admin!.id },
        });
        return { tenant: publicTenant(tenant!), admin_user_id: admin!.id };
      });
    },
  });
}
