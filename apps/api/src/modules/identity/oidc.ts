import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { randomToken } from '../../lib/crypto';

export interface OidcProviderConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  authorization_response_iss_parameter_supported?: boolean;
}

export interface IdTokenClaims extends JWTPayload {
  sub: string;
  email?: string;
  name?: string;
  nonce?: string;
  amr?: string[];
  sid?: string;
}

export class OidcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const DISCOVERY_TTL_MS = 10 * 60_000;

export function pkcePair() {
  const verifier = randomToken(48);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/**
 * Minimal OpenID Connect relying party: discovery, Authorization Code + PKCE,
 * server-side code exchange and ID token validation. Each issuer gets its own
 * cached metadata and JWKS.
 */
export class OidcClient {
  private discovery = new Map<string, { doc: Discovery; at: number }>();
  private jwks = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  async discover(issuer: string): Promise<Discovery> {
    const cached = this.discovery.get(issuer);
    if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) return cached.doc;
    const url = `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new OidcError('idp_unavailable', `discovery failed with ${res.status}`);
    const doc = (await res.json()) as Discovery;
    // The metadata must describe the issuer we asked for (OIDC Discovery 4.3).
    if (doc.issuer !== issuer) throw new OidcError('idp_misconfigured', 'issuer mismatch in discovery');
    this.discovery.set(issuer, { doc, at: Date.now() });
    return doc;
  }

  async authorizationUrl(
    provider: OidcProviderConfig,
    params: { redirectUri: string; state: string; nonce: string; codeChallenge: string; loginHint?: string; scope?: string },
  ): Promise<string> {
    const d = await this.discover(provider.issuer);
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', params.scope ?? 'openid email profile');
    url.searchParams.set('state', params.state);
    url.searchParams.set('nonce', params.nonce);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (params.loginHint) url.searchParams.set('login_hint', params.loginHint);
    return url.toString();
  }

  /** Exchanges the code (server side, with client authentication) and validates the ID token. */
  async completeLogin(
    provider: OidcProviderConfig,
    params: { code: string; redirectUri: string; codeVerifier: string; nonce: string; iss?: string | null },
  ): Promise<IdTokenClaims> {
    const d = await this.discover(provider.issuer);
    // RFC 9207 mix-up protection
    if (params.iss && params.iss !== provider.issuer) {
      throw new OidcError('invalid_issuer', 'authorization response issuer mismatch');
    }
    if (!params.iss && d.authorization_response_iss_parameter_supported) {
      throw new OidcError('invalid_issuer', 'authorization response is missing iss');
    }

    const res = await this.fetchImpl(d.token_endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization:
          'Basic ' +
          Buffer.from(
            `${encodeURIComponent(provider.clientId)}:${encodeURIComponent(provider.clientSecret)}`,
          ).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.id_token !== 'string') {
      throw new OidcError('token_exchange_failed', String(body.error ?? `status ${res.status}`));
    }

    let jwks = this.jwks.get(d.jwks_uri);
    if (!jwks) {
      jwks = createRemoteJWKSet(new URL(d.jwks_uri));
      this.jwks.set(d.jwks_uri, jwks);
    }
    let payload: IdTokenClaims;
    try {
      const verified = await jwtVerify(body.id_token, jwks, {
        issuer: provider.issuer,
        audience: provider.clientId,
        algorithms: ['RS256', 'ES256', 'PS256'],
        clockTolerance: 30,
      });
      payload = verified.payload as IdTokenClaims;
    } catch (err) {
      throw new OidcError('invalid_id_token', (err as Error).message);
    }
    if (!payload.sub) throw new OidcError('invalid_id_token', 'missing sub');
    if (payload.nonce !== params.nonce) throw new OidcError('invalid_nonce', 'nonce mismatch');
    return payload;
  }

  async endSessionUrl(issuer: string, postLogoutRedirect: string): Promise<string | null> {
    try {
      const d = await this.discover(issuer);
      if (!d.end_session_endpoint) return null;
      const url = new URL(d.end_session_endpoint);
      url.searchParams.set('post_logout_redirect_uri', postLogoutRedirect);
      return url.toString();
    } catch {
      return null;
    }
  }
}

const MFA_METHODS = new Set(['mfa', 'otp', 'hwk', 'swk', 'sms', 'fpt', 'face', 'pop']);

/** True when the IdP reported a second factor (RFC 8176 amr values). */
export function hasMfa(amr: string[] | undefined): boolean {
  return !!amr?.some((m) => MFA_METHODS.has(m));
}
