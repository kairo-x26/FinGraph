import type { Config } from '../../config';
import { RetryableJobError } from '../jobs/errors';

export interface TokenSet {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  checksum: string | null;
}

/** The provider rejected the access token; the caller may refresh once. */
export class TokenRejectedError extends Error {}
/** The refresh token is no longer valid; the user must reconnect. */
export class ReauthorizationRequired extends Error {}

export interface ConnectorProvider {
  readonly id: 'sandbox_drive' | 'google_drive';
  readonly label: string;
  readonly scopes: string[];
  authorizationUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string;
  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }): Promise<TokenSet>;
  refresh(refreshToken: string): Promise<TokenSet>;
  revoke(token: string): Promise<void>;
  accountLabel(accessToken: string): Promise<string | null>;
  listFiles(accessToken: string, pageToken?: string | null): Promise<{ files: RemoteFile[]; nextPageToken: string | null }>;
  download(accessToken: string, fileId: string): Promise<Buffer>;
}

interface OAuthEndpoints {
  authorize: string;
  token: string;
  revoke: string;
}

abstract class OAuthProvider {
  constructor(
    protected readonly endpoints: OAuthEndpoints,
    protected readonly clientId: string,
    protected readonly clientSecret: string,
    protected readonly fetchImpl: typeof fetch = fetch,
  ) {}

  protected extraAuthParams(): Record<string, string> {
    return {};
  }

  abstract readonly scopes: string[];

  authorizationUrl(p: { state: string; codeChallenge: string; redirectUri: string }) {
    const u = new URL(this.endpoints.authorize);
    const params = {
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: p.redirectUri,
      scope: this.scopes.join(' '),
      state: p.state,
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
      ...this.extraAuthParams(),
    };
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.toString();
  }

  protected async tokenRequest(body: Record<string, string>): Promise<TokenSet> {
    const res = await this.fetchImpl(this.endpoints.token, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.status === 400 && json.error === 'invalid_grant') throw new ReauthorizationRequired(String(json.error_description ?? 'invalid_grant'));
    if (res.status >= 500 || res.status === 429) throw new RetryableJobError('provider_unavailable', `token endpoint ${res.status}`);
    if (!res.ok || typeof json.access_token !== 'string') throw new Error(`token request failed: ${String(json.error ?? res.status)}`);
    return json as unknown as TokenSet;
  }

  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }) {
    return this.tokenRequest({ grant_type: 'authorization_code', code: p.code, code_verifier: p.codeVerifier, redirect_uri: p.redirectUri });
  }

  refresh(refreshToken: string) {
    return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string) {
    await this.fetchImpl(this.endpoints.revoke, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`${encodeURIComponent(this.clientId)}:${encodeURIComponent(this.clientSecret)}`).toString('base64')}`,
      },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10_000),
    });
  }

  protected async api(url: string, accessToken: string): Promise<Response> {
    const res = await this.fetchImpl(url, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(30_000) });
    if (res.status === 401) throw new TokenRejectedError('access token rejected');
    if (res.status === 429 || res.status >= 500) throw new RetryableJobError('provider_unavailable', `provider returned ${res.status}`);
    if (!res.ok) throw new Error(`provider request failed with ${res.status}`);
    return res;
  }
}

/** The local sandbox repository (apps/sandbox). */
export class SandboxDriveProvider extends OAuthProvider implements ConnectorProvider {
  readonly id = 'sandbox_drive' as const;
  readonly label = 'Sandbox Drive';
  readonly scopes = ['drive.readonly', 'offline_access'];

  constructor(
    private readonly base: string,
    clientId: string,
    clientSecret: string,
    fetchImpl?: typeof fetch,
    publicBase: string = base,
  ) {
    // the consent page is opened by the browser; token and file calls go server to server
    super({ authorize: `${publicBase}/authorize`, token: `${base}/token`, revoke: `${base}/revoke` }, clientId, clientSecret, fetchImpl);
  }

  async accountLabel() {
    return 'Sandbox Drive';
  }

  async listFiles(accessToken: string, pageToken?: string | null) {
    const u = new URL(`${this.base}/drive/v1/files`);
    if (pageToken) u.searchParams.set('page_token', pageToken);
    const body = (await (await this.api(u.toString(), accessToken)).json()) as {
      files: { id: string; name: string; mimeType: string; modifiedTime: string; size: number; md5Checksum: string }[];
      next_page_token: string | null;
    };
    return {
      files: body.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size, checksum: f.md5Checksum })),
      nextPageToken: body.next_page_token,
    };
  }

  async download(accessToken: string, fileId: string) {
    return Buffer.from(await (await this.api(`${this.base}/drive/v1/files/${encodeURIComponent(fileId)}/content`, accessToken)).arrayBuffer());
  }
}

/** Google Drive (read-only), using Google's OAuth 2.0 endpoints and Drive API v3. */
export class GoogleDriveProvider extends OAuthProvider implements ConnectorProvider {
  readonly id = 'google_drive' as const;
  readonly label = 'Google Drive';
  readonly scopes = ['https://www.googleapis.com/auth/drive.readonly', 'openid', 'email'];

  constructor(clientId: string, clientSecret: string, fetchImpl?: typeof fetch) {
    super(
      { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' },
      clientId,
      clientSecret,
      fetchImpl,
    );
  }

  protected override extraAuthParams() {
    return { access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' };
  }

  async accountLabel(accessToken: string) {
    try {
      const r = (await (await this.api('https://openidconnect.googleapis.com/v1/userinfo', accessToken)).json()) as { email?: string };
      return r.email ?? null;
    } catch {
      return null;
    }
  }

  async listFiles(accessToken: string, pageToken?: string | null) {
    const u = new URL('https://www.googleapis.com/drive/v3/files');
    u.searchParams.set('pageSize', '100');
    u.searchParams.set('fields', 'nextPageToken,files(id,name,mimeType,modifiedTime,size,md5Checksum)');
    u.searchParams.set(
      'q',
      "trashed = false and (mimeType = 'application/pdf' or mimeType = 'image/png' or mimeType = 'image/jpeg' or mimeType = 'text/plain' or mimeType = 'text/csv' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')",
    );
    if (pageToken) u.searchParams.set('pageToken', pageToken);
    const body = (await (await this.api(u.toString(), accessToken)).json()) as {
      files: { id: string; name: string; mimeType: string; modifiedTime: string; size?: string; md5Checksum?: string }[];
      nextPageToken?: string;
    };
    return {
      files: body.files.map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime, size: f.size ? Number(f.size) : null, checksum: f.md5Checksum ?? null })),
      nextPageToken: body.nextPageToken ?? null,
    };
  }

  async download(accessToken: string, fileId: string) {
    return Buffer.from(await (await this.api(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, accessToken)).arrayBuffer());
  }
}

export function connectorProviders(config: Config): Map<string, ConnectorProvider> {
  const out = new Map<string, ConnectorProvider>();
  if (config.SANDBOX_CONNECTOR ?? config.NODE_ENV !== 'production') {
    out.set(
      'sandbox_drive',
      new SandboxDriveProvider(config.SANDBOX_URL, config.SANDBOX_CONNECTOR_CLIENT_ID, config.SANDBOX_CONNECTOR_CLIENT_SECRET, undefined, config.SANDBOX_PUBLIC_URL ?? config.SANDBOX_URL),
    );
  }
  if (config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET) {
    out.set('google_drive', new GoogleDriveProvider(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET));
  }
  return out;
}
