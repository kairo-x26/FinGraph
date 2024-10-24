import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests run against an isolated stack on separate ports:
 * sandbox IdP :4110, API :4010 (fresh embedded database, seeded), web :3010.
 */
const WEB = 'http://localhost:3010';

export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'pnpm --filter @fingraph/sandbox start',
      url: 'http://localhost:4110/.well-known/openid-configuration',
      env: { SANDBOX_PORT: '4110', SANDBOX_ISSUER: 'http://localhost:4110', SANDBOX_CALLBACK_BASE: `${WEB}/api` },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: 'node -e "require(\'fs\').rmSync(\'.data/e2e\',{recursive:true,force:true})" && tsx scripts/seed.ts && tsx src/main.ts',
      cwd: 'apps/api',
      url: 'http://localhost:4010/readyz',
      env: {
        PORT: '4010',
        DATABASE_URL: 'pglite://./.data/e2e/pg',
        STORAGE_LOCAL_DIR: './.data/e2e/objects',
        PUBLIC_API_URL: `${WEB}/api`,
        WEB_URL: WEB,
        OIDC_ISSUER: 'http://localhost:4110',
        SANDBOX_URL: 'http://localhost:4110',
        WORKER_INLINE: 'true',
        WORKER_POLL_MS: '200',
        LOG_LEVEL: 'warn',
        RATE_LIMIT_PER_MINUTE: '5000',
      },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: 'pnpm --filter @fingraph/web exec next build && pnpm --filter @fingraph/web exec next start --port 3010',
      url: `${WEB}/login`,
      env: { API_INTERNAL_URL: 'http://localhost:4010' },
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
