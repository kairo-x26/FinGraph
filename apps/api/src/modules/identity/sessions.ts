import { isRole, permissionsFor, type Role } from '@fingraph/shared';
import type { Config } from '../../config';
import type { AuthContext } from '../../context';
import type { Database, Tx } from '../../db';
import { randomToken, sha256Hex } from '../../lib/crypto';
import { settingsOf, type TenantRow } from './tenants';

export const SESSION_COOKIE = 'fg_session';
export const CSRF_COOKIE = 'fg_csrf';

export interface SessionCreate {
  tenantId: string;
  userId: string;
  amr: string[];
  idpSessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export async function createSession(tx: Tx, config: Config, tenant: TenantRow, input: SessionCreate) {
  const token = randomToken(32);
  const csrf = randomToken(24);
  const settings = settingsOf(tenant);
  const hours = settings.session_absolute_hours ?? config.SESSION_ABSOLUTE_HOURS;
  const row = await tx.one<{ id: string; expires_at: Date }>(
    `insert into sessions (tenant_id, user_id, token_hash, csrf_token, amr, idp_session_id, ip, user_agent, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + make_interval(hours => $9))
     returning id, expires_at`,
    [
      input.tenantId,
      input.userId,
      sha256Hex(token),
      csrf,
      input.amr,
      input.idpSessionId ?? null,
      input.ip ?? null,
      input.userAgent?.slice(0, 500) ?? null,
      hours,
    ],
  );
  return { token, csrf, id: row!.id, expiresAt: row!.expires_at };
}

interface SessionLookup {
  session_id: string;
  tenant_id: string;
  user_id: string;
  csrf_token: string;
  last_seen_at: Date;
  expires_at: Date;
  email: string;
  display_name: string;
  roles: string[];
  user_status: string;
  tenant_status: string;
  tenant_settings: unknown;
}

/**
 * Resolves a session token into an auth context. Enforces absolute expiry, idle
 * timeout, user and tenant status. Touches `last_seen_at` at most once a minute.
 */
export async function resolveSession(db: Database, config: Config, token: string): Promise<AuthContext | null> {
  if (!token || token.length > 200) return null;
  return db.system(async (tx) => {
    const s = await tx.one<SessionLookup>(
      `select s.id as session_id, s.tenant_id, s.user_id, s.csrf_token, s.last_seen_at, s.expires_at,
              u.email, u.display_name, u.roles, u.status as user_status,
              t.status as tenant_status, t.settings as tenant_settings
         from sessions s
         join users u on u.id = s.user_id
         join tenants t on t.id = s.tenant_id
        where s.token_hash = $1 and s.revoked_at is null`,
      [sha256Hex(token)],
    );
    if (!s) return null;
    const now = Date.now();
    const idleMinutes = settingsOf({ settings: s.tenant_settings }).session_idle_minutes ?? config.SESSION_IDLE_MINUTES;
    const idleExpired = now - new Date(s.last_seen_at).getTime() > idleMinutes * 60_000;
    if (new Date(s.expires_at).getTime() < now || idleExpired || s.user_status !== 'active' || s.tenant_status !== 'active') {
      await tx.query('update sessions set revoked_at = now() where id = $1 and revoked_at is null', [s.session_id]);
      return null;
    }
    if (now - new Date(s.last_seen_at).getTime() > 60_000) {
      await tx.query('update sessions set last_seen_at = now() where id = $1', [s.session_id]);
    }
    const roles = s.roles.filter(isRole) as Role[];
    return {
      kind: 'user',
      tenantId: s.tenant_id,
      userId: s.user_id,
      clientId: null,
      email: s.email,
      displayName: s.display_name,
      roles,
      permissions: permissionsFor(roles),
      sessionId: s.session_id,
      csrfToken: s.csrf_token,
      scopes: [],
    } satisfies AuthContext;
  });
}

export async function revokeSession(tx: Tx, sessionId: string) {
  await tx.query('update sessions set revoked_at = now() where id = $1 and revoked_at is null', [sessionId]);
}

export async function revokeUserSessions(tx: Tx, userId: string) {
  const r = await tx.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
  return r.rowCount;
}
