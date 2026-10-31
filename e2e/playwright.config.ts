import { defineConfig, devices } from '@playwright/test';
import path from 'node:path';

const root = path.resolve(__dirname, '..');
const databaseUrl = process.env.E2E_DATABASE_URL ?? 'postgresql://monty:monty_dev@localhost:5432/monty_e2e';

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
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3100',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node packages/database/dist/migrate-cli.js && node apps/api/dist/main.js',
      cwd: root,
      url: 'http://localhost:4100/api/v1/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: databaseUrl,
        API_PORT: '4100',
        ALLOWED_ORIGINS: 'http://localhost:3100',
        LOG_LEVEL: 'warn',
        AUTH_RATE_LIMIT: '1000',
        NODE_ENV: 'development',
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
