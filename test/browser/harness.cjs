/**
 * TopFlowNG — browser-test harness (Playwright webServer).
 *
 * Boots the REAL server against a dedicated throwaway PostgreSQL database with
 * the external layers mocked (Clubkonnect, Resend/email, OpenRouter), then
 * stays up until Playwright terminates it. The throwaway DB is best-effort
 * dropped on SIGTERM/exit, and deterministically swept by the repo's Playwright
 * `globalTeardown` after the run. Used by `playwright.config.js` webServer. No
 * real external provider is ever contacted — OpenRouter base is an unreachable
 * loopback and the module itself is mocked at the require boundary.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('node:child_process');

const pgHelper = require('../helpers/pg');

const ROOT = path.resolve(__dirname, '..', '..');
const DB_PREFIX = 'topflowng_ui';
const TEST_PORT = 3210;

// ── Environment (set before config.js / database.js / server.js are loaded) ─
process.env.NODE_ENV = 'test';
process.env.PORT = String(TEST_PORT);
process.env.TRUST_PROXY = '0';
process.env.JWT_SECRET = 'browser-test-jwt-secret-not-for-prod';
process.env.AUTH_RATE_MAX = '100000';
process.env.API_RATE_MAX = '100000';
process.env.PURCHASE_RATE_MAX = '100000';
process.env.AUTH_LOCKOUT_MAX_FAILURES = '3';
process.env.AUTH_LOCKOUT_WINDOW_MS = '600000';
process.env.AUTH_LOCKOUT_DURATION_MS = '600000';
process.env.SENTRY_DSN = '';
process.env.PAYSTACK_WEBHOOK_SECRET = 'browser-webhook-secret';
process.env.PAYSTACK_SECRET_KEY = 'browser-secret-key';
process.env.DATABASE_URL = pgHelper.createDatabaseSync(DB_PREFIX);

process.env.OPENROUTER_API_KEY = 'sk-or-v1-ui-test-never-used';
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:1'; // unreachable loopback
process.env.OPENROUTER_PRIMARY_MODEL = 'deepseek/deepseek-v4-flash';
process.env.OPENROUTER_FALLBACK_MODEL = 'hermes';
process.env.OPENROUTER_APP_URL = 'https://topflowng.test';
process.env.OPENROUTER_APP_NAME = 'TopFlowNG-Test';
process.env.AI_TIMEOUT_MS = '5000';
process.env.AI_MAX_INPUT_LENGTH = '2000';
process.env.AI_MAX_OUTPUT_TOKENS = '128';
process.env.AI_RATE_WINDOW_MS = '60000';
process.env.AI_RATE_MAX = '1000';
process.env.AI_DAILY_REQUEST_CEILING = '1000000';
process.env.AI_DAILY_COST_CEILING = '0';

function installMock(relPath, exports) {
  const abs = path.join(ROOT, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

installMock('services/clubkonnect.js', {
  MAX_PURCHASE_AMOUNT: 1000000,
  parseValidatedAmount: (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; },
  CK_PENDING_CODES: new Set([100, 199, 299]),
  normalizeClubkonnectResponse: (raw) => ({ ...raw }),
  queryClubkonnectOrder: async () => ({ outcome: 'pending' }),
  processClubkonnectPurchase: async () => ({ outcome: 'pending', message: 'Held', requestId: 'x', orderId: 'PRV-1', provider: { raw: {} } }),
});

installMock('services/email.js', {
  async sendEmail() {},
  async sendPurchaseEmail() {},
});

installMock('services/openrouter.js', {
  async chatCompletion() {
    return {
      content: { kind: 'text', text: 'I am the mocked assistant.' },
      model: 'deepseek/deepseek-v4-flash',
      usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
    };
  },
});

const http = require('http');
let capturedServer = null;
const origCreateServer = http.createServer;
http.createServer = function (...args) {
  const srv = origCreateServer.apply(this, args);
  capturedServer = srv;
  return srv;
};

require(path.join(ROOT, 'server.js'));

const BASE_URL = `http://127.0.0.1:${TEST_PORT}`;

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not become healthy in time');
}

async function shutdown() {
  try {
    const db = require(path.join(ROOT, 'database.js'));
    if (typeof db.closePool === 'function') await db.closePool().catch(() => {});
  } catch { /* best effort */ }
  if (capturedServer && typeof capturedServer.close === 'function') {
    try { await new Promise((r) => capturedServer.close(r)); } catch { /* best effort */ }
  }
  await pgHelper.dropDatabase(DB_PREFIX);
  process.exit(0);
}

// Playwright hard-kills a webServer (SIGKILL) before an async cleanup can
// finish, so the definitive throwaway-DB sweep is handled by `globalTeardown`
// (runs in the main process after all tests). The sync exit-hook below is a
// best-effort guard for graceful/explicit kills.
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => pgHelper.dropDatabaseSync(DB_PREFIX));

(async () => {
  await waitForServer();
  console.log(`BROWSER_HARNESS_READY ${BASE_URL}`);
  // Migrations (idempotency schema) applied for parity with other suites.
  try {
    execFileSync('node', [path.join(ROOT, 'migrations', 'migrate.js')], {
      env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
      encoding: 'utf8',
    });
  } catch { /* migration files may be optional in this harness */ }
})();
