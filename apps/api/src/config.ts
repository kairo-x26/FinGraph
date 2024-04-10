import { z } from 'zod';

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  /** Public URL of this API, used for OAuth callbacks and signed upload URLs. */
  PUBLIC_API_URL: z.string().url().default('http://localhost:4000'),
  /** URL of the web application, used for post-login redirects and CORS. */
  WEB_URL: z.string().url().default('http://localhost:3000'),

  /**
   * `postgres://...` for a real server, `pglite://memory` for an in-memory database or
   * `pglite://./.data/pg` for a persistent embedded database.
   */
  DATABASE_URL: z.string().default('pglite://./.data/pg'),
  DATABASE_POOL_SIZE: z.coerce.number().int().default(10),

  /** 32+ byte secret used to sign upload URLs, CSRF tokens and encrypt connector tokens. */
  APP_SECRET: z.string().min(32).default('dev-only-secret-change-me-0123456789abcdef'),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./.data/objects'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_ENDPOINT: z.string().optional(),

  /** Default identity provider for tenants without their own SSO configuration. */
  OIDC_ISSUER: z.string().url().default('http://localhost:4100'),
  OIDC_CLIENT_ID: z.string().default('fingraph-web'),
  OIDC_CLIENT_SECRET: z.string().default('dev-client-secret'),

  SESSION_IDLE_MINUTES: z.coerce.number().int().default(30),
  SESSION_ABSOLUTE_HOURS: z.coerce.number().int().default(12),
  COOKIE_SECURE: bool.default(false),

  /** Run background workers inside the API process (development convenience). */
  WORKER_INLINE: bool.default(true),
  WORKER_CONCURRENCY: z.coerce.number().int().default(2),
  WORKER_POLL_MS: z.coerce.number().int().default(500),

  MAX_UPLOAD_BYTES: z.coerce.number().int().default(25 * 1024 * 1024),
  MALWARE_SCANNER: z.enum(['builtin', 'clamav']).default('builtin'),
  CLAMAV_HOST: z.string().default('127.0.0.1'),
  CLAMAV_PORT: z.coerce.number().int().default(3310),

  OCR_PROVIDER: z.enum(['none', 'tesseract']).default('none'),
  EMBEDDING_PROVIDER: z.enum(['local', 'voyage', 'openai']).default('local'),
  EMBEDDING_API_KEY: z.string().optional(),
  LLM_PROVIDER: z.enum(['local', 'anthropic']).default('local'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5-5'),

  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(600),

  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  SANDBOX_URL: z.string().url().default('http://localhost:4100'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  const config = parsed.data;
  if (config.NODE_ENV === 'production' && config.APP_SECRET.startsWith('dev-only')) {
    throw new Error('APP_SECRET must be set in production');
  }
  return config;
}

export function testConfig(overrides: Partial<Record<keyof Config, string>> = {}): Config {
  return loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'pglite://memory',
    WORKER_INLINE: 'false',
    ...overrides,
  });
}
