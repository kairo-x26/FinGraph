import { z } from 'zod';
import type { Config } from '../../config';
import type { Tx } from '../../db';
import { decrypt, deriveKey, encrypt } from '../../lib/crypto';
import type { OidcProviderConfig } from './oidc';

export const tenantSettingsSchema = z.object({
  require_mfa: z.boolean().default(true),
  session_idle_minutes: z.number().int().min(5).max(24 * 60).optional(),
  session_absolute_hours: z.number().int().min(1).max(72).optional(),
  allowed_email_domains: z.array(z.string().min(3).max(253)).max(50).default([]),
  default_retention_days: z.number().int().min(30).max(36500).default(2555),
  exports_require_approval: z.boolean().default(false),
  quotas: z
    .object({
      documents_per_day: z.number().int().min(1).default(10_000),
      storage_bytes: z.number().int().min(1).default(50 * 1024 ** 3),
      ai_tokens_per_day: z.number().int().min(1).default(2_000_000),
      ocr_pages_per_day: z.number().int().min(1).default(20_000),
    })
    .default({
      documents_per_day: 10_000,
      storage_bytes: 50 * 1024 ** 3,
      ai_tokens_per_day: 2_000_000,
      ocr_pages_per_day: 20_000,
    }),
});
export type TenantSettings = z.infer<typeof tenantSettingsSchema>;

export interface TenantRow {
  id: string;
  slug: string;
  name: string;
  status: 'active' | 'suspended';
  settings: unknown;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_enc: string | null;
  created_at: Date;
}

export function settingsOf(t: Pick<TenantRow, 'settings'>): TenantSettings {
  return tenantSettingsSchema.parse(t.settings ?? {});
}

const secretKey = (config: Config) => deriveKey(config.APP_SECRET, 'tenant-idp-secret');

export function encryptIdpSecret(config: Config, tenantId: string, secret: string) {
  return encrypt(secretKey(config), secret, tenantId);
}

/** The tenant's own SSO configuration, or the platform default IdP. */
export function oidcProviderFor(config: Config, t: TenantRow): OidcProviderConfig {
  if (t.oidc_issuer && t.oidc_client_id && t.oidc_client_secret_enc) {
    return {
      issuer: t.oidc_issuer,
      clientId: t.oidc_client_id,
      clientSecret: decrypt(secretKey(config), t.oidc_client_secret_enc, t.id),
    };
  }
  return {
    issuer: config.OIDC_ISSUER,
    clientId: config.OIDC_CLIENT_ID,
    clientSecret: config.OIDC_CLIENT_SECRET,
  };
}

export async function tenantBySlug(tx: Tx, slug: string) {
  return tx.one<TenantRow>('select * from tenants where slug = $1', [slug]);
}

export function publicTenant(t: TenantRow) {
  return {
    id: t.id,
    slug: t.slug,
    name: t.name,
    status: t.status,
    settings: settingsOf(t),
    sso: { issuer: t.oidc_issuer, client_id: t.oidc_client_id, custom: !!t.oidc_issuer },
    created_at: t.created_at,
  };
}
