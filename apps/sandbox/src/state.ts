import type { SandboxClient, SandboxUser } from './idp';

export interface SandboxState {
  issuer: string;
  users: SandboxUser[];
  clients: SandboxClient[];
  accessTokenTtlSec: number;
  refreshTokens: Map<string, { sub: string; scope: string; client_id: string; revoked: boolean }>;
  resolveAccessToken: (token: string) => { sub: string; scope: string; client_id: string } | null;
}

export const DEFAULT_USERS: SandboxUser[] = [
  { sub: 'u-admin', email: 'alex.admin@acme.test', name: 'Alex Morgan', password: 'password', mfa: true },
  { sub: 'u-analyst', email: 'ana.analyst@acme.test', name: 'Ana Ruiz', password: 'password', mfa: true },
  { sub: 'u-analyst2', email: 'sam.analyst@acme.test', name: 'Sam Okafor', password: 'password', mfa: true },
  { sub: 'u-risk', email: 'rita.risk@acme.test', name: 'Rita Chen', password: 'password', mfa: true },
  { sub: 'u-onboard', email: 'omar.onboarding@acme.test', name: 'Omar Haddad', password: 'password', mfa: true },
  { sub: 'u-audit', email: 'ivy.auditor@acme.test', name: 'Ivy Lindqvist', password: 'password', mfa: true },
  { sub: 'u-dev', email: 'dev.integrations@acme.test', name: 'Dana Park', password: 'password', mfa: true },
  { sub: 'u-nomfa', email: 'casey.contractor@acme.test', name: 'Casey Lee', password: 'password', mfa: false },
  { sub: 'u-other', email: 'olga@globex.test', name: 'Olga Petrova', password: 'password', mfa: true },
];

export function defaultClients(apiCallbackBase: string): SandboxClient[] {
  return [
    {
      client_id: 'fingraph-web',
      client_secret: 'dev-client-secret',
      redirect_uris: [`${apiCallbackBase}/v1/auth/callback`],
      scopes: ['openid', 'email', 'profile'],
    },
    {
      client_id: 'fingraph-connector',
      client_secret: 'dev-connector-secret',
      redirect_uris: [`${apiCallbackBase}/v1/connections/sandbox_drive/callback`],
      scopes: ['drive.readonly', 'offline_access'],
    },
  ];
}
