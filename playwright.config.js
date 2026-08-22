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
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Allow CI / sandbox envs to override the Chromium binary when the
        // version bundled with this Playwright release is not pre-installed.
        ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
          ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } }
          : {}),
      },
    },
    // Cross-engine smoke coverage (browsers installed via
    // `npx playwright install firefox webkit` where available).
    // serviceWorkers blocked on the cross-engine projects: WebKit upgrades
    // http://127.0.0.1 SW-scope subresources to https in this local harness
    // (production serves https, so this is a test-env-only artifact).
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], serviceWorkers: 'block' },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], serviceWorkers: 'block' },
    },
  ],
  webServer: {
    command: 'node test/browser/harness.cjs',
    url: `${HARNESS_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 40_000,
  },
});