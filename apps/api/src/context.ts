import type { FastifyBaseLogger } from 'fastify';
import type { Permission, Role } from '@fingraph/shared';
import type { Config } from './config';
import type { Database } from './db';
import type { MalwareScanner } from './modules/documents/scanner';
import type { OcrProvider } from './modules/extraction/ocr';
import type { ObjectStorage } from './storage';

export interface AuthContext {
  kind: 'user' | 'api_client';
  tenantId: string;
  /** Set for interactive users. */
  userId: string | null;
  /** Set for OAuth API clients. */
  clientId: string | null;
  email: string | null;
  displayName: string | null;
  roles: Role[];
  permissions: Set<Permission>;
  sessionId: string | null;
  csrfToken: string | null;
  scopes: string[];
}

export interface Actor {
  type: 'user' | 'api_client' | 'system';
  id: string | null;
}

export function actorOf(auth: AuthContext | null | undefined): Actor {
  if (!auth) return { type: 'system', id: null };
  if (auth.kind === 'api_client') return { type: 'api_client', id: auth.clientId };
  return { type: 'user', id: auth.userId };
}

export interface AppContext {
  config: Config;
  db: Database;
  log: FastifyBaseLogger;
  storage: ObjectStorage;
  scanner: MalwareScanner;
  ocr: OcrProvider | null;
}

/** Overridable services, mainly for tests. */
export type ServiceOverrides = Partial<Omit<AppContext, 'config' | 'db' | 'log'>>;
