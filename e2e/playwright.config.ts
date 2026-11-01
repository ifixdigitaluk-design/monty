import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
// Owner for migrations; the API runs as the restricted monty_app role so row-level security is exercised end to end.
const ownerUrl = process.env.E2E_DATABASE_URL ?? 'postgresql://monty:monty_dev@localhost:5432/monty_e2e';
const appUrl = process.env.E2E_APP_DATABASE_URL ?? 'postgresql://monty_app:monty_app_dev@localhost:5432/monty_e2e';

/**
 * Runs the real stack: built API (port 4100) + built Next.js app (port 3100) + Postgres.
 * Build first: `pnpm build` (with API_INTERNAL_URL=http://localhost:4100 for the web build).
 */
export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Local OpenID provider standing in for Google (see apps/api/test/fake-oidc.mjs).
      command: 'node apps/api/test/fake-oidc.mjs',
      cwd: root,
      url: 'http://127.0.0.1:4300/.well-known/openid-configuration',
      reuseExistingServer: false,
      timeout: 30_000,
      env: { FAKE_OIDC_PORT: '4300' },
    },
    {
      command: 'node packages/database/dist/migrate-cli.js && node apps/api/dist/main.js',
      cwd: root,
      url: 'http://localhost:4100/api/v1/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        MIGRATION_DATABASE_URL: ownerUrl,
        DATABASE_URL: appUrl,
        REQUIRE_RLS: 'true',
        API_PORT: '4100',
        ALLOWED_ORIGINS: 'http://localhost:3100',
        LOG_LEVEL: 'warn',
        AUTH_RATE_LIMIT: '1000',
        NODE_ENV: 'development',
        APP_URL: 'http://localhost:3100',
        MAIL_TRANSPORT: 'log',
        GOOGLE_CLIENT_ID: 'test-client',
        GOOGLE_CLIENT_SECRET: 'test-secret',
        OIDC_ISSUER: 'http://127.0.0.1:4300',
      },
    },
    {
      command: 'pnpm --filter @monty/web exec next start --port 3100',
      cwd: root,
      url: 'http://localhost:3100/login',
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_INTERNAL_URL: 'http://localhost:4100', NEXT_TELEMETRY_DISABLED: '1' },
    },
  ],
});
