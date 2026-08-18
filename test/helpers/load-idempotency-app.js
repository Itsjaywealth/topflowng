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

// ── Mock provider (never dials VTPass) ──────────────────────────────────
const providerState = {
  calls: 0,
  outcome: 'success', // 'success' | 'pending' | 'failed'
  queryOutcome: 'pending', // what queryVtpassOrder reports during reconciliation
  queryCalls: 0,
  async reset() {
    providerState.calls = 0;
    providerState.outcome = 'success';
    providerState.queryOutcome = 'pending';
    providerState.queryCalls = 0;
  },
};

const mockProvider = {
  getProductRegistry: () => [],
  MAX_PURCHASE_AMOUNT: 1000000,
  parseValidatedAmount: (value) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : null;
  },
  buildRequestId: () => 'TEST-' + Date.now().toString(36),
  VtpassProductError: class VtpassProductError extends Error {
    constructor(message) { super(message); this.name = 'VtpassProductError'; this.code = 'VTPASS_PRODUCT_UNAVAILABLE'; }
  },
  productFor: (serviceType, ctx) => ({ serviceID: 'test-' + serviceType, ...(ctx || {}) }),
  authConfig: () => ({ headers: {} }),
  assertConfigured: () => {},
  fetchVariations: async () => [],
  VTPASS_SUCCESS_CODES: new Set(['000']),
  normalizeVtpassResponse: (raw) => ({ ...raw, status: raw.response_description || raw.response, remark: raw.response_description }),
  queryVtpassOrder: async () => {
    providerState.queryCalls += 1;
    const outcome = providerState.queryOutcome;
    if (outcome === 'success') {
      return { outcome: 'success', statusCode: '000', status: 'ORDER_COMPLETED', remark: 'Confirmed', description: 'Delivered', orderId: 'QUERY-ORDER', raw: { response: 'success', response_description: 'Transaction completed' } };
    }
    if (outcome === 'failed') {
      return { outcome: 'failed', statusCode: '400', status: 'ORDER_ERROR', remark: 'Declined', description: 'Provider declined', orderId: 'QUERY-ORDER', raw: { response: 'failed', response_description: 'Transaction failed' } };
    }
    return { outcome: 'pending', statusCode: '199', status: 'ORDER_RECEIVED', remark: 'On hold', description: 'Pending', orderId: 'QUERY-ORDER', raw: { response: 'pending', response_description: 'Transaction processing' } };
  },
  async processVtpassPurchase({ requestId, userId, serviceType, amount, description }) {
    const db = require(path.join(ROOT, 'database.js'));
    providerState.calls += 1;
    await db.createVtuAttempt({ requestId, userId, serviceType, amount, description });

    const orderId = `VTP-${providerState.calls}`;
    if (providerState.outcome === 'success') {
      await db.recordVtuProviderResponse(requestId, {
        orderId, statusCode: '000', status: 'ORDER_COMPLETED',
        remark: 'Success', description: 'Delivered', raw: { 
          requestId: `VTP-${Date.now()}`,
          response: 'success',
          response_code: '000',
          response_description: 'Transaction completed'
        },
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
        orderId, statusCode: '400', status: 'ORDER_ERROR',
        remark: 'Declined', description: 'Provider declined', 
        raw: { 
          response: 'failed',
          response_description: 'Transaction failed'
        },
      });
      await db.markVtuOrderFailed(requestId);
      return { outcome: 'failed', message: 'Provider declined', requestId, orderId, provider: { raw: {} } };
    }
    await db.recordVtuProviderResponse(requestId, {
      orderId, statusCode: '199', status: 'ORDER_RECEIVED',
      remark: 'On hold', description: 'Pending', 
      raw: { 
        response: 'pending',
        response_description: 'Transaction processing'
      },
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

installMock('services/vtpass.js', mockProvider);
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
  // Give the pg pool's per-connection teardown callbacks (error events fired by the
  // five failed concurrent debits) time to drain before DROP DATABASE sends
  // pg_terminate_backend. Without this pause those callbacks fire as uncaughtExceptions
  // attributed to the last test on Node 18/20.
  await new Promise((r) => setTimeout(r, 250));
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
