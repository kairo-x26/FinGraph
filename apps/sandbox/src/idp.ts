import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { escapeHtml, page } from './html';
import type { SandboxState } from './state';

export interface SandboxUser {
  sub: string;
  email: string;
  name: string;
  password: string;
  /** Users with MFA enrolled must enter the one-time code. */
  mfa: boolean;
}

export interface SandboxClient {
  client_id: string;
  client_secret: string;
  redirect_uris: string[];
  /** Scopes the client may request. */
  scopes: string[];
}

export const DEV_OTP = '246810';

interface AuthCode {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  nonce: string | null;
  sub: string;
  scope: string;
  amr: string[];
  expires: number;
  used: boolean;
}

const b64url = (buf: Buffer) => buf.toString('base64url');
const s256 = (v: string) => b64url(createHash('sha256').update(v).digest());

function clientAuth(req: FastifyRequest, clients: SandboxClient[]): SandboxClient | null {
  const body = (req.body ?? {}) as Record<string, string>;
  let id = body.client_id;
  let secret = body.client_secret;
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    const [u, p] = Buffer.from(header.slice(6), 'base64').toString().split(':');
    id = decodeURIComponent(u ?? '');
    secret = decodeURIComponent(p ?? '');
  }
  const client = clients.find((c) => c.client_id === id);
  return client && client.client_secret === secret ? client : null;
}

function oauthError(reply: FastifyReply, status: number, error: string, description: string) {
  return reply.code(status).send({ error, error_description: description });
}

export async function registerIdp(app: FastifyInstance, state: SandboxState) {
  const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'sandbox-1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, AuthCode>();
  const accessTokens = new Map<string, { sub: string; scope: string; client_id: string; expires: number }>();

  app.get('/.well-known/openid-configuration', async () => ({
    issuer: state.issuer,
    authorization_endpoint: `${state.issuer}/authorize`,
    token_endpoint: `${state.issuer}/token`,
    userinfo_endpoint: `${state.issuer}/userinfo`,
    jwks_uri: `${state.issuer}/jwks`,
    end_session_endpoint: `${state.issuer}/logout`,
    revocation_endpoint: `${state.issuer}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    subject_types_supported: ['public'],
    id_token_signing_alg_values_supported: ['RS256'],
    scopes_supported: ['openid', 'email', 'profile', 'offline_access', 'drive.readonly'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
    authorization_response_iss_parameter_supported: true,
    claims_supported: ['sub', 'email', 'name', 'amr', 'nonce'],
  }));

  app.get('/jwks', async () => ({ keys: [jwk] }));

  function validateAuthorize(q: Record<string, string>) {
    const client = state.clients.find((c) => c.client_id === q.client_id);
    if (!client) return { fatal: 'Unknown client_id.' };
    if (!q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      return { fatal: 'redirect_uri is not registered for this client.' };
    }
    if (q.response_type !== 'code') return { client, error: 'unsupported_response_type' };
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return { client, error: 'invalid_request', description: 'PKCE with S256 is required' };
    }
    const scopes = (q.scope ?? '').split(' ').filter(Boolean);
    if (scopes.some((s) => !client.scopes.includes(s))) return { client, error: 'invalid_scope' };
    return { client, scopes };
  }

  function redirectWith(reply: FastifyReply, redirectUri: string, params: Record<string, string>) {
    const url = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('iss', state.issuer);
    return reply.redirect(url.toString(), 302);
  }

  const passthrough = [
    'response_type',
    'client_id',
    'redirect_uri',
    'scope',
    'state',
    'nonce',
    'code_challenge',
    'code_challenge_method',
    'prompt',
    'login_hint',
  ];

  app.get('/authorize', async (req, reply) => {
    const q = req.query as Record<string, string>;
    const v = validateAuthorize(q);
    if ('fatal' in v) return reply.code(400).type('text/html').send(page('Sign-in error', `<p>${escapeHtml(v.fatal!)}</p>`));
    if (v.error) return redirectWith(reply, q.redirect_uri!, { error: v.error, state: q.state ?? '' });

    const consent = v.scopes!.includes('drive.readonly');
    const hidden = passthrough
      .filter((k) => q[k] !== undefined)
      .map((k) => `<input type="hidden" name="${k}" value="${escapeHtml(q[k]!)}">`)
      .join('');
    const options = state.users
      .map((u) => `<option value="${escapeHtml(u.email)}"${u.email === q.login_hint ? ' selected' : ''}>${escapeHtml(u.name)} (${escapeHtml(u.email)})</option>`)
      .join('');
    const body = `
      <form method="post" action="/authorize">
        ${hidden}
        <label>Account<select name="email">${options}</select></label>
        <label>Password<input name="password" type="password" value="password" autocomplete="current-password"></label>
        <label>One-time code <small>(accounts with MFA, dev code ${DEV_OTP})</small><input name="otp" inputmode="numeric" autocomplete="one-time-code"></label>
        ${consent ? `<p class="consent"><strong>${escapeHtml(v.client!.client_id)}</strong> is requesting read-only access to your Sandbox Drive files.</p>` : ''}
        <div class="row">
          <button name="decision" value="allow" type="submit">${consent ? 'Allow access' : 'Sign in'}</button>
          <button name="decision" value="deny" type="submit" class="secondary">${consent ? 'Deny' : 'Cancel'}</button>
        </div>
      </form>`;
    return reply.type('text/html').send(page(consent ? 'Grant Sandbox Drive access' : 'Sign in to the sandbox IdP', body));
  });

  app.post('/authorize', async (req, reply) => {
    const q = req.body as Record<string, string>;
    const v = validateAuthorize(q);
    if ('fatal' in v) return reply.code(400).send({ error: 'invalid_request', error_description: v.fatal });
    if (v.error) return redirectWith(reply, q.redirect_uri!, { error: v.error, state: q.state ?? '' });
    if (q.decision === 'deny') {
      return redirectWith(reply, q.redirect_uri!, { error: 'access_denied', state: q.state ?? '' });
    }
    const user = state.users.find((u) => u.email === q.email);
    if (!user || user.password !== q.password) {
      return reply.code(401).type('text/html').send(page('Sign-in failed', '<p>Wrong email or password.</p>'));
    }
    const amr = ['pwd'];
    if (user.mfa) {
      if (q.otp !== DEV_OTP) {
        return reply.code(401).type('text/html').send(page('Sign-in failed', '<p>The one-time code is incorrect.</p>'));
      }
      amr.push('otp', 'mfa');
    }
    const code = b64url(randomBytes(24));
    codes.set(code, {
      client_id: q.client_id!,
      redirect_uri: q.redirect_uri!,
      code_challenge: q.code_challenge!,
      nonce: q.nonce ?? null,
      sub: user.sub,
      scope: q.scope ?? 'openid',
      amr,
      expires: Date.now() + 60_000,
      used: false,
    });
    return redirectWith(reply, q.redirect_uri!, { code, state: q.state ?? '' });
  });

  async function issueTokens(clientId: string, sub: string, scope: string, extra: { nonce?: string | null; amr?: string[] }) {
    const user = state.users.find((u) => u.sub === sub)!;
    const accessToken = b64url(randomBytes(32));
    accessTokens.set(accessToken, { sub, scope, client_id: clientId, expires: Date.now() + state.accessTokenTtlSec * 1000 });
    const out: Record<string, unknown> = {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: state.accessTokenTtlSec,
      scope,
    };
    if (scope.split(' ').includes('openid')) {
      out.id_token = await new SignJWT({
        email: user.email,
        name: user.name,
        amr: extra.amr,
        ...(extra.nonce ? { nonce: extra.nonce } : {}),
        sid: randomUUID(),
      })
        .setProtectedHeader({ alg: 'RS256', kid: jwk.kid! })
        .setIssuer(state.issuer)
        .setAudience(clientId)
        .setSubject(sub)
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(privateKey);
    }
    if (scope.split(' ').includes('offline_access')) {
      const refresh = b64url(randomBytes(32));
      state.refreshTokens.set(refresh, { sub, scope, client_id: clientId, revoked: false });
      out.refresh_token = refresh;
    }
    return out;
  }

  app.post('/token', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const client = clientAuth(req, state.clients);
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');

    if (body.grant_type === 'authorization_code') {
      const entry = body.code ? codes.get(body.code) : undefined;
      if (!entry || entry.used || entry.expires < Date.now() || entry.client_id !== client.client_id) {
        return oauthError(reply, 400, 'invalid_grant', 'Code is invalid, expired or already used');
      }
      entry.used = true;
      if (entry.redirect_uri !== body.redirect_uri) {
        return oauthError(reply, 400, 'invalid_grant', 'redirect_uri mismatch');
      }
      if (!body.code_verifier || s256(body.code_verifier) !== entry.code_challenge) {
        return oauthError(reply, 400, 'invalid_grant', 'PKCE verification failed');
      }
      return issueTokens(client.client_id, entry.sub, entry.scope, { nonce: entry.nonce, amr: entry.amr });
    }

    if (body.grant_type === 'refresh_token') {
      const rt = body.refresh_token ? state.refreshTokens.get(body.refresh_token) : undefined;
      if (!rt || rt.revoked || rt.client_id !== client.client_id) {
        return oauthError(reply, 400, 'invalid_grant', 'Refresh token is invalid or revoked');
      }
      // Rotation: the presented refresh token is single use.
      rt.revoked = true;
      return issueTokens(client.client_id, rt.sub, rt.scope, {});
    }

    return oauthError(reply, 400, 'unsupported_grant_type', 'Unsupported grant_type');
  });

  app.post('/revoke', async (req, reply) => {
    const client = clientAuth(req, state.clients);
    if (!client) return oauthError(reply, 401, 'invalid_client', 'Client authentication failed');
    const token = (req.body as Record<string, string>)?.token;
    if (token) {
      const rt = state.refreshTokens.get(token);
      if (rt && rt.client_id === client.client_id) {
        rt.revoked = true;
        for (const [k, v] of accessTokens) if (v.sub === rt.sub && v.client_id === client.client_id) accessTokens.delete(k);
      }
      accessTokens.delete(token);
    }
    return reply.code(200).send({});
  });

  /** Resolves a bearer access token; exposed for the drive API. */
  state.resolveAccessToken = (token: string) => {
    const t = accessTokens.get(token);
    if (!t || t.expires < Date.now()) return null;
    return t;
  };

  app.get('/userinfo', async (req, reply) => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const t = state.resolveAccessToken(token);
    if (!t) return reply.code(401).send({ error: 'invalid_token' });
    const user = state.users.find((u) => u.sub === t.sub)!;
    return { sub: user.sub, email: user.email, name: user.name };
  });

  app.get('/logout', async (req, reply) => {
    const q = req.query as Record<string, string>;
    if (q.post_logout_redirect_uri) return reply.redirect(q.post_logout_redirect_uri, 302);
    return reply.type('text/html').send(page('Signed out', '<p>You are signed out of the sandbox IdP.</p>'));
  });
}
