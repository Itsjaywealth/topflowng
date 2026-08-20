/**
 * TopFlowNG — Phase 6 AI test harness.
 *
 * Boots the REAL server against a DEDICATED throwaway PostgreSQL database with
 * only three external layers mocked: Clubkonnect (provider), Resend (email),
 * and OpenRouter (services/openrouter.js). The real database.js and the real
 * AI service (services/ai.js) + route (routes/ai.js) run end-to-end over HTTP.
 * Because openrouter.js is mocked at the require boundary, zero real OpenRouter
 * (or any other external) requests are ever made.
 */

'use strict';

const path = require('path');
const { execFileSync } = require('node:child_process');

const pgHelper = require('./pg');
const ROOT = path.resolve(__dirname, '..', '..');

const DB_PREFIX = 'topflowng_ai';

// Create the throwaway DB synchronously BEFORE server.js is required.
const DATABASE_URL = pgHelper.createDatabaseSync(DB_PREFIX);

// Provide distinct dummy models so tests can detect primary vs fallback.
const PRIMARY_MODEL = 'deepseek/deepseek-v4-flash';
const FALLBACK_MODEL = 'hermes-model';

// ── Environment (set before config.js / database.js / server.js are loaded) ─
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
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
// Disable markup / service fees and discounts so wallet debits equal the
// service amount exactly (defaults: 2% airtime markup, ₦2 min, ₦100 elec fee,
// 2% weekend happy hour).
process.env.AIRTIME_MARKUP_RATE = '0';
process.env.AIRTIME_MIN_MARKUP = '0';
process.env.ELECTRICITY_SERVICE_FEE = '0';
process.env.DISCOUNT_AIRTIME_PERCENT = '0';
process.env.DISCOUNT_DATA_PERCENT = '0';
process.env.DISCOUNT_CABLE_PERCENT = '0';
process.env.DISCOUNT_ELECTRICITY_PERCENT = '0';
process.env.DISCOUNT_EXAM_PERCENT = '0';
process.env.DISCOUNT_WEEKEND_HAPPY_HOUR_PERCENT = '0';
process.env.DISCOUNT_WEEKEND_HAPPY_HOUR = 'false';

// AI config: a real-looking key (never used — openrouter is mocked), a base
// URL that points at an unreachable loopback so any accidental real call would
// fail fast and never reach a provider.
process.env.OPENROUTER_API_KEY = 'sk-or-v1-test-key-never-used';
process.env.OPENROUTER_BASE_URL = 'http://127.0.0.1:1';
process.env.OPENROUTER_PRIMARY_MODEL = PRIMARY_MODEL;
process.env.OPENROUTER_FALLBACK_MODEL = FALLBACK_MODEL;
process.env.OPENROUTER_APP_URL = 'https://topflowng.test';
process.env.OPENROUTER_APP_NAME = 'TopFlowNG-Test';
process.env.AI_TIMEOUT_MS = '5000';
process.env.AI_MAX_INPUT_LENGTH = '2000';
process.env.AI_MAX_OUTPUT_TOKENS = '64';
process.env.AI_RATE_MAX = '3';
process.env.AI_RATE_WINDOW_MS = '60000';
process.env.AI_DAILY_REQUEST_CEILING = '1000000';
process.env.AI_DAILY_COST_CEILING = '0';
process.env.AI_MODEL_ALLOWLIST = 'extra/allowed-model';

function installMock(relPath, exports) {
  const abs = path.join(ROOT, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// ── Mock provider (never dials Clubkonnect) ────────────────────────────────
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
  normalizeVtpassResponse: (raw) => ({ ...raw, status: raw.code, remark: raw.response_description }),
  queryVtpassOrder: async () => ({ outcome: 'pending' }),
  processVtpassPurchase: async () => ({ outcome: 'success', balance: 0, requestId: 'x', orderId: 'VTP-1', provider: { raw: {} } }),
};

installMock('services/vtpass.js', mockProvider);
installMock('services/email.js', {
  async sendEmail() {},
  async sendPurchaseEmail() {},
  async sendOrderStatusEmail() {},
  async sendInvoiceEmail() {},
});

// ── Mock OpenRouter (scriptable — the ONLY OpenRouter contact point) ────────
const aiState = {
  calls: [],                        // every request: { model, messages, tools, maxTokens }
  onCall: null,                     // async (ctx) => response | throw
  defaultResponse: {
    content: { kind: 'text', text: 'I am the mocked assistant.' },
    model: PRIMARY_MODEL,
    usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
  },
  reset() {
    aiState.calls = [];
    aiState.onCall = null;
    aiState.defaultResponse = {
      content: { kind: 'text', text: 'I am the mocked assistant.' },
      model: PRIMARY_MODEL,
      usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
    };
  },
};

const mockOpenrouter = {
  async chatCompletion(ctx) {
    aiState.calls.push({
      model: ctx.model,
      messages: ctx.messages,
      tools: ctx.tools,
      maxTokens: ctx.maxTokens,
    });
    const handler = aiState.onCall || (() => aiState.defaultResponse);
    return handler(ctx);
  },
  __state: aiState,
};

installMock('services/openrouter.js', mockOpenrouter);

// ── Boot the real app ──────────────────────────────────────────────────────
const http = require('http');
let capturedServer = null;
const origCreateServer = http.createServer;
http.createServer = function (...args) {
  const srv = origCreateServer.apply(this, args);
  capturedServer = srv;
  return srv;
};

require(path.join(ROOT, 'server.js'));

function resolvedPort() {
  if (capturedServer && capturedServer.address) {
    const a = capturedServer.address();
    if (a && typeof a === 'object') return a.port;
  }
  return null;
}

function baseUrl() {
  const port = resolvedPort();
  return port ? `http://127.0.0.1:${port}` : null;
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const url = baseUrl();
    if (url) {
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) return;
      } catch { /* not up yet */ }
    }
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

async function api(method, pathname, { body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(baseUrl() + pathname, {
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
  await new Promise((r) => setTimeout(r, 250));
  await pgHelper.dropDatabase(DB_PREFIX);
}

module.exports = {
  DATABASE_URL,
  get BASE_URL() {
    return baseUrl() || `http://127.0.0.1:0`;
  },
  PRIMARY_MODEL,
  FALLBACK_MODEL,
  waitForServer,
  applyMigrations,
  api,
  aiState,
  mockOpenrouter,
  cleanup,
  db: () => require(path.join(ROOT, 'database.js')),
};
