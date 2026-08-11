/**
 * TopFlowNG — Phase 4D idempotency test harness.
 *
 * Boots the REAL server against a DEDICATED throwaway PostgreSQL database
 * (created, migrated, and dropped here) with only the provider (Clubkonnect)
 * and email layers mocked. The real `database.js` (real transactions, row
 * locks, wallet debits) and the real VTU routes + idempotency service are
 * exercised end-to-end over HTTP. No real external service is ever contacted.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('node:child_process');

const pgHelper = require('./pg');
const ROOT = path.resolve(__dirname, '..', '..');

const DB_PREFIX = 'topflowng_idem';
const TEST_PORT = String(Number(process.pid) % 50000 + 10000);

// Create the throwaway DB synchronously BEFORE server.js is required (it
// connects on boot). No psql binary needed — uses only the `pg` package.
const DATABASE_URL = pgHelper.createDatabaseSync(DB_PREFIX);

// ── Environment (set before config.js / database.js are required) ──────────
process.env.NODE_ENV = 'test';
process.env.PORT = TEST_PORT;
process.env.TRUST_PROXY = '0';
process.env.JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
process.env.AUTH_RATE_MAX = '100000';
process.env.API_RATE_MAX = '100000';
process.env.PURCHASE_RATE_MAX = '100000';
process.env.AUTH_LOCKOUT_MAX_FAILURES = '3';
process.env.AUTH_LOCKOUT_WINDOW_MS = '600000';
process.env.AUTH_LOCKOUT_DURATION_MS = '600000';
process.env.SENTRY_DSN = '';
process.env.PAYSTACK_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.PAYSTACK_SECRET_KEY = 'test-secret-key';
process.env.DATABASE_URL = DATABASE_URL;

// ── Mock provider (never dials Clubkonnect) ─────────────────────────────────
const providerState = {
  calls: 0,
  outcome: 'success', // 'success' | 'pending' | 'failed'
  queryOutcome: 'pending', // what queryClubkonnectOrder reports during reconciliation
  queryCalls: 0,
  async reset() {
    providerState.calls = 0;
    providerState.outcome = 'success';
    providerState.queryOutcome = 'pending';
    providerState.queryCalls = 0;
  },
};

const mockProvider = {
  MAX_PURCHASE_AMOUNT: 1000000,
  parseValidatedAmount: (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  CK_PENDING_CODES: new Set([100, 199, 299]),
  normalizeClubkonnectResponse: (raw) => ({ ...raw }),
  queryClubkonnectOrder: async () => {
    providerState.queryCalls += 1;
    const outcome = providerState.queryOutcome;
    if (outcome === 'success') {
      return { outcome: 'success', statusCode: 200, status: 'ORDER_COMPLETED', remark: 'Confirmed', description: 'Delivered', orderId: 'QUERY-ORDER', raw: {} };
    }
    if (outcome === 'failed') {
      return { outcome: 'failed', statusCode: 400, status: 'ORDER_ERROR', remark: 'Declined', description: 'Provider declined', orderId: 'QUERY-ORDER', raw: {} };
    }
    return { outcome: 'pending', statusCode: 199, status: 'ORDER_RECEIVED', remark: 'On hold', description: 'Pending', orderId: 'QUERY-ORDER', raw: {} };
  },
  async processClubkonnectPurchase({ requestId, userId, serviceType, amount, description }) {
    const db = require(path.join(ROOT, 'database.js'));
    providerState.calls += 1;
    await db.createVtuAttempt({ requestId, userId, serviceType, amount, description });

    const orderId = `PRV-${providerState.calls}`;
    if (providerState.outcome === 'success') {
      await db.recordVtuProviderResponse(requestId, {
        orderId, statusCode: 200, status: 'ORDER_COMPLETED',
        remark: 'Success', description: 'Delivered', raw: { token: 'ELEC-TOKEN-001' },
      });
      try {
        const result = await db.completeVtuOrder(requestId);
        return { outcome: 'success', balance: result.balance, requestId, orderId, provider: { raw: { token: 'ELEC-TOKEN-001' } } };
      } catch {
        await db.markVtuOrderPending(requestId).catch(() => {});
        return { outcome: 'pending', message: 'Held for reconciliation', requestId, orderId, provider: { raw: { token: 'ELEC-TOKEN-001' } } };
      }
    }
    if (providerState.outcome === 'failed') {
      await db.recordVtuProviderResponse(requestId, {
        orderId, statusCode: 400, status: 'ORDER_ERROR',
        remark: 'Declined', description: 'Provider declined', raw: {},
      });
      await db.markVtuOrderFailed(requestId);
      return { outcome: 'failed', message: 'Provider declined', requestId, orderId, provider: { raw: {} } };
    }
    await db.recordVtuProviderResponse(requestId, {
      orderId, statusCode: 199, status: 'ORDER_RECEIVED',
      remark: 'On hold', description: 'Pending', raw: {},
    });
    await db.markVtuOrderPending(requestId);
    return {
      outcome: 'pending',
      message: 'Your request is pending provider confirmation. Your wallet has not been debited.',
      requestId, orderId, provider: { raw: {} },
    };
  },
};

function installMock(relPath, exports) {
  const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

installMock('services/clubkonnect.js', mockProvider);
installMock('services/email.js', {
  async sendEmail() {},
  async sendPurchaseEmail() {},
  async sendOrderStatusEmail() {},
  async sendAutoRechargeEmail(...args) { emailState.autoRechargeCalls.push(args); },
  async sendInvoiceEmail(...args) { emailState.invoiceCalls.push(args); },
});

// ── Mock axios (never dials Paystack) ────────────────────────────────────────
const emailState = {
  autoRechargeCalls: [],
  invoiceCalls: [],
  reset() {
    emailState.autoRechargeCalls = [];
    emailState.invoiceCalls = [];
  },
};
const realAxios = require('axios');
const mockAxios = {
  ...realAxios,
  async post(url, body, config) {
    if (String(url).includes('/transaction/initialize')) {
      const reference = body?.reference || `AR-${Date.now()}`;
      autoRechargeState.initializeCalls.push({ url, body, config });
      return {
        data: {
          status: true,
          data: {
            reference,
            authorization_url: `https://checkout.paystack.com/${reference}`,
            access_code: 'test-access-code',
          },
        },
      };
    }
    throw new Error(`Unexpected axios POST in test: ${url}`);
  },
  async get() { throw new Error('Unexpected axios GET in test'); },
};
const autoRechargeState = {
  initializeCalls: [],
  reset() { autoRechargeState.initializeCalls = []; },
};
installMock(require.resolve('axios'), mockAxios);

// ── Boot the real app ────────────────────────────────────────────────────────
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

async function waitForServer(timeoutMs = 15000) {
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

function applyMigrations() {
  execFileSync('node', [path.join(ROOT, 'migrations', 'migrate.js')], {
    env: { ...process.env, DATABASE_URL },
    encoding: 'utf8',
  });
}

async function api(method, pathname, { body, token, idempotencyKey } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (idempotencyKey !== undefined) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(BASE_URL + pathname, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function cleanup() {
  if (capturedServer && typeof capturedServer.close === 'function') {
    await new Promise((resolve) => capturedServer.close(resolve));
    capturedServer = null;
  }
  try {
    const db = require(path.join(ROOT, 'database.js'));
    if (typeof db.closePool === 'function') await db.closePool().catch(() => {});
  } catch { /* best effort */ }
  await pgHelper.dropDatabase(DB_PREFIX);
}

module.exports = {
  DATABASE_URL,
  BASE_URL,
  waitForServer,
  applyMigrations,
  api,
  providerState,
  mockProvider,
  autoRechargeState,
  emailState,
  cleanup,
};