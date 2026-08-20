/**
 * TopFlowNG — Phase 3 test harness.
 *
 * Injects in-memory mocks for the database, email, and provider layers via
 * `require.cache` BEFORE `server.js` is loaded, then boots the real Express app
 * on a throwaway port. Guarantees zero real external requests: no Postgres, no
 * Resend, no Paystack, no Clubkonnect.
 *
 * The real `services/security.js` (lockout + token revocation) is exercised.
 */

'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// Bind an OS-assigned ephemeral port (0) instead of deriving one from the
// process PID. Parallel `node --test --experimental-test-coverage` runs spawn
// one process per file; PID-derived ports (pid % N + offset) collided across
// harnesses (load-app / load-ai-app / load-idempotency-app use overlapping
// ranges), which intermittently produced EADDRINUSE and the CI flake
// "Server did not become healthy in time". The real bound port is read back
// from the captured server after it starts listening.

// Capture the http.Server instance that express's app.listen creates so the
// test runner can shut it down and exit cleanly.
const http = require('http');
let capturedServer = null;
const origCreateServer = http.createServer;
http.createServer = function (...args) {
  const srv = origCreateServer.apply(this, args);
  capturedServer = srv;
  return srv;
};

// ── Environment (must be set before config.js is required) ──────────────────
process.env.NODE_ENV = 'test';
process.env.PORT = '0';
process.env.TRUST_PROXY = '0';
process.env.JWT_SECRET = 'test-jwt-secret-do-not-use-in-prod';
process.env.AUTH_RATE_MAX = '100000';
process.env.API_RATE_MAX = '100000';
process.env.AUTH_LOCKOUT_MAX_FAILURES = '3';
process.env.AUTH_LOCKOUT_WINDOW_MS = '600000';
process.env.AUTH_LOCKOUT_DURATION_MS = '600000';
process.env.SENTRY_DSN = '';
process.env.PAYSTACK_WEBHOOK_SECRET = 'test-webhook-secret';
process.env.PAYSTACK_SECRET_KEY = 'test-secret-key';
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

function installMock(relPath, exports) {
  const abs = path.join(ROOT, relPath);
  require.cache[abs] = { id: abs, filename: abs, loaded: true, exports };
}

// ── Mock database (in-memory) ────────────────────────────────────────────────
const bcrypt = require('bcryptjs');
const MOCK_SALT_ROUNDS = 4;

let nextUserId = 1;
const users = [];
const resets = [];
const transactions = [];
const directOrders = [];
let nextOrderId = 1;

const mockDb = {
  async initDB() {},

  async ping() {
    return { ok: true };
  },

  async findUserByEmail(email) {
    const e = String(email || '').trim().toLowerCase();
    return users.find((u) => u.email.toLowerCase() === e) || null;
  },

  async findUserByPhone(phone) {
    return users.find((u) => u.phone === String(phone || '').trim()) || null;
  },

  async findUserById(id) {
    return users.find((u) => u.id === Number(id)) || null;
  },

  async findUserByReferralCode(code) {
    return users.find((u) => u.referral_code === String(code)) || null;
  },

  async createUser({ fullName, email, phone, password, referredBy = null }) {
    const password_hash = await bcrypt.hash(password, MOCK_SALT_ROUNDS);
    const user = {
      id: nextUserId++,
      full_name: fullName,
      email,
      phone,
      password: password_hash,
      wallet: 0,
      is_admin: false,
      created_at: new Date().toISOString(),
      referral_code: null,
      referred_by: referredBy,
    };
    users.push(user);
    return { ...user };
  },

  async verifyPassword(user, password) {
    return bcrypt.compare(password, user.password);
  },

  async updateUserPassword(userId, newPassword) {
    const user = users.find((u) => u.id === Number(userId));
    if (user) user.password = await bcrypt.hash(newPassword, MOCK_SALT_ROUNDS);
  },

  async createPasswordReset(userId, token) {
    resets.push({
      id: resets.length + 1,
      user_id: Number(userId),
      token,
      used: false,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
  },

  async consumePasswordReset(token, newPassword) {
    const reset = resets.find((r) => r.token === token && !r.used && new Date(r.expires_at) > new Date());
    if (!reset) throw new Error('Invalid or expired reset token');
    reset.used = true;
    const user = users.find((u) => u.id === reset.user_id);
    if (user) user.password = await bcrypt.hash(newPassword, MOCK_SALT_ROUNDS);
  },

  async getAdminStats() {
    return {
      total_credited: 0,
      total_debited: 0,
      total_users: users.length,
      total_transactions: 0,
    };
  },

  async getAllTransactions(limit = 50, offset = 0) {
    return [];
  },

  async getAllUsers(limit = 50, offset = 0) {
    return users.map(({ password, ...u }) => u);
  },

  async getWalletBalance(userId) {
    const user = users.find((u) => u.id === Number(userId));
    return user ? user.wallet : 0;
  },

  // ── Direct-pay order mock (PAYMENT_MODE=direct) ──────────────────────────
  async createDirectOrder({ requestId, userId, serviceType, amount, description, paymentReference, requestPayload = null }) {
    const order = { request_id: requestId, user_id: Number(userId), service_type: serviceType, amount, description, payment_reference: paymentReference, payment_status: 'pending', status: 'submitted', request_payload: requestPayload, id: nextOrderId++ };
    directOrders.push(order);
    return order;
  },
  async findOrderByPaymentReference(paymentReference) {
    return directOrders.find((o) => o.payment_reference === paymentReference) || null;
  },
  async markOrderPaid(requestId, paymentReference) {
    const order = directOrders.find((o) => o.request_id === requestId);
    if (order) { order.payment_status = 'paid'; order.paid_at = new Date().toISOString(); if (paymentReference) order.payment_reference = paymentReference; }
    return order;
  },
  async __resetDirectOrders() { directOrders.length = 0; },
  __getDirectOrders() { return directOrders; },

  async getTransactions(userId, { limit = 20, offset = 0, q = null, category = null, status = null, from = null, to = null } = {}) {
    let list = transactions.filter((t) => t.user_id === userId);
    if (q) list = list.filter((t) => (t.description || '').toLowerCase().includes(String(q).toLowerCase()) || (t.reference || '').toLowerCase().includes(String(q).toLowerCase()));
    list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(offset, offset + limit);
    return { transactions: list, total: transactions.filter((t) => t.user_id === userId).length };
  },

  async setTransactionPin() {},
  async hasTransactionPin() { return false; },
  async verifyTransactionPin() { return false; },

  // ── Test helpers ──────────────────────────────────────────────────────────
  __seedUser({ fullName, email, phone, password, isAdmin = false }) {
    const user = {
      id: nextUserId++,
      full_name: fullName,
      email,
      phone,
      password: null,
      wallet: 0,
      is_admin: isAdmin,
      created_at: new Date().toISOString(),
      referral_code: null,
      referred_by: null,
    };
    users.push(user);
    return user;
  },

  __setPassword(id, passwordHash) {
    const user = users.find((u) => u.id === id);
    if (user) user.password = passwordHash;
  },

  __lastResetToken() {
    const last = resets[resets.length - 1];
    return last ? last.token : null;
  },

  __reset() {
    users.length = 0;
    resets.length = 0;
    nextUserId = 1;
    notifications.length = 0;
  },
};

const notifications = [];

// ── Mock in-app notifications ────────────────────────────────────────────────
mockDb.createNotification = async ({ userId, category = 'transaction', title, message, link = null }) => {
  const n = { id: notifications.length + 1, user_id: userId, category, title, message, link, read_at: null, created_at: new Date().toISOString() };
  notifications.push(n);
  return { ...n };
};

mockDb.getNotifications = async (userId, { limit = 30, offset = 0, category = null, unreadOnly = false } = {}) => {
  let list = notifications.filter((n) => n.user_id === userId);
  if (category && category !== 'all') list = list.filter((n) => n.category === category);
  if (unreadOnly) list = list.filter((n) => !n.read_at);
  list = [...list].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(offset, offset + limit);
  return { notifications: list, total: notifications.filter((n) => n.user_id === userId).length };
};

mockDb.getUnreadNotificationCount = async (userId) => notifications.filter((n) => n.user_id === userId && !n.read_at).length;

mockDb.markNotificationRead = async (userId, id) => {
  const n = notifications.find((x) => x.id === id && x.user_id === userId);
  if (!n) return null;
  n.read_at = n.read_at || new Date().toISOString();
  return { id, read_at: n.read_at };
};

mockDb.markAllNotificationsRead = async (userId) => {
  let count = 0;
  for (const n of notifications) {
    if (n.user_id === userId && !n.read_at) { n.read_at = new Date().toISOString(); count++; }
  }
  return count;
};

mockDb.deleteNotification = async (userId, id) => {
  const idx = notifications.findIndex((x) => x.id === id && x.user_id === userId);
  if (idx === -1) return null;
  return notifications.splice(idx, 1)[0];
};

installMock('database.js', mockDb);

// ── Mock email (records sends, never dials Resend) ──────────────────────────
const sentEmails = [];
installMock('services/email.js', {
  async sendEmail({ to, subject, html }) {
    sentEmails.push({ to, subject, html });
  },
  async sendPurchaseEmail() {},
  async sendOrderStatusEmail() {},
  async sendInvoiceEmail({ to, subject, html }) {
    sentEmails.push({ to, subject, html });
  },
  __sentEmails: sentEmails,
});

// ── Mock provider client (never dials VTPass) ──────────────────────────
installMock('services/vtpass.js', {
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
  processVtpassPurchase: async () => ({ outcome: 'pending' }),
});

// ── Boot the real app ────────────────────────────────────────────────────────
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
  // First wait for the captured server to actually be listening (port 0 is
  // resolved asynchronously by the kernel), then poll health on that port.
  while (Date.now() - start < timeoutMs) {
    const url = baseUrl();
    if (url) {
      try {
        const res = await fetch(`${url}/api/health`);
        if (res.ok) return url;
      } catch { /* not up yet */ }
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Server did not become healthy in time');
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

async function register(payload) {
  return api('POST', '/api/auth/register', { body: payload });
}

async function login(email, password) {
  return api('POST', '/api/auth/login', { body: { email, password } });
}

async function createUserViaDb({ fullName, email, phone, password }) {
  const hash = await bcrypt.hash(password, MOCK_SALT_ROUNDS);
  const user = mockDb.__seedUser({ fullName, email, phone, password: null });
  mockDb.__setPassword(user.id, hash);
  return user;
}

module.exports = {
  get BASE_URL() {
    return baseUrl() || `http://127.0.0.1:0`;
  },
  waitForServer,
  api,
  register,
  login,
  mockDb,
  sentEmails,
  bcrypt,
  createUserViaDb,
  closeServer() {
    if (capturedServer && typeof capturedServer.close === 'function') {
      capturedServer.close();
      capturedServer = null;
    }
  },
};
