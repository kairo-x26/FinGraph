import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import { registerDrive } from './drive';
import { registerIdp, type SandboxClient, type SandboxUser } from './idp';
import { DEFAULT_USERS, defaultClients, type SandboxState } from './state';

export { DEV_OTP } from './idp';
export type { SandboxClient, SandboxUser } from './idp';
export { DEFAULT_USERS } from './state';

export interface SandboxOptions {
  issuer?: string;
  /** Base URL that FinGraph OAuth callbacks are served from. */
  apiCallbackBase?: string;
  users?: SandboxUser[];
  clients?: SandboxClient[];
  accessTokenTtlSec?: number;
  logger?: boolean;
}

export interface Sandbox {
  app: FastifyInstance;
  state: SandboxState;
  /** Starts listening; returns the base URL and sets it as issuer when none was given. */
  listen(port?: number, host?: string): Promise<string>;
}

export async function createSandbox(opts: SandboxOptions = {}): Promise<Sandbox> {
  const app = Fastify({ logger: opts.logger ?? false });
  await app.register(formbody);
  const state: SandboxState = {
    issuer: opts.issuer ?? '',
    users: opts.users ?? DEFAULT_USERS,
    clients: opts.clients ?? defaultClients(opts.apiCallbackBase ?? 'http://localhost:4000'),
    accessTokenTtlSec: opts.accessTokenTtlSec ?? 3600,
    refreshTokens: new Map(),
    resolveAccessToken: () => null,
    driveFiles: new Map(),
  };
  await registerIdp(app, state);
  await registerDrive(app, state);

  return {
    app,
    state,
    async listen(port = 0, host = '127.0.0.1') {
      const address = await app.listen({ port, host });
      if (!state.issuer) state.issuer = address.replace('[::1]', 'localhost');
      return address;
    },
  };
}
