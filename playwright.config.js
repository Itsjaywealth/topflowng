/**
 * TopFlowNG — Playwright configuration (browser quality checks).
 *
 * Boots the app once via the repository-owned harness (throwaway Postgres DB,
 * mocked providers/OpenRouter) and serves it at http://127.0.0.1:3210. The
 * browser binary is NOT committed — install it locally with
 * `npm run test:browser:install` (npx playwright install chromium); CI installs
 * it explicitly. Uses a single worker for deterministic behaviour.
 */

'use strict';

const { defineConfig, devices } = require('@playwright/test');

const HARNESS_URL = 'http://127.0.0.1:3210';

module.exports = defineConfig({
  testDir: './test/browser/tests',
  globalTeardown: './test/browser/global-teardown.cjs',
  timeout: 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: HARNESS_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'node test/browser/harness.cjs',
    url: `${HARNESS_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 40_000,
  },
});