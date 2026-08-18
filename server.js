/**
 * TopFlowNG — Production Backend
 *
 * Stack: Express · PostgreSQL · JWT · Paystack · VTPass VTU
 * Security: Helmet · express-rate-limit · CORS · Sentry
 *
 * Configuration is centralised in config.js; structured logging in
 * lib/logger.js; VTU/provider logic lives in routes/vtu.js and
 * services/vtpass.js.
 */

'use strict';

// ── Sentry (must be first) ──────────────────────────────────────────────────
const Sentry = require('@sentry/node');
const config = require('./config');
if (config.sentry.dsn) {
  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    tracesSampleRate: config.sentry.tracesSampleRate,
  });
}

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const axios = require('axios');

const db = require('./database');
const logger = require('./lib/logger');
const security = require('./services/security');
const { authMiddleware, adminMiddleware, checkTransactionPin } = require('./middleware/auth');
const { authLimiter, apiLimiter, purchaseLimiter } = require('./middleware/rate-limit');
const vtuRouter = require('./routes/vtu');
const aiRouter = require('./routes/ai').router;
const { queryVtpassOrder, processVtpassPurchase } = require('./services/vtpass');
const { sendEmail, sendPurchaseEmail, sendOrderStatusEmail, sendAutoRechargeEmail, sendInvoiceEmail } = require('./services/email');
const { sendError } = require('./lib/errors');
const { normalizeEmail, isValidEmail, isValidPhone } = require('./lib/validate');
const {
  validate,
  registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema,
  changePasswordSchema, setPinSchema, resetPinSchema, verifyPinSchema,
  paystackInitSchema, beneficiaryAddSchema,
  autoRechargeSchema, scheduledPurchaseSchema,
} = require('./lib/schemas');
const { validatePlanAmount, validateCablePlanAmount } = require('./services/pricing');

const DUMMY_BCRYPT_HASH = '$2b$12$C6UzMDM.H6dfI/f/IKcEeO7BmW2g8K7P3XyZGkN6QqKxE6y1yJ2eC';

const app = express();
app.set('trust proxy', config.trustProxy ? 1 : 0); // Trust proxy for rate limiting
const PORT = config.port;

// ── Security Middleware ──────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // The SPA ships its JS inline (no build step), so inline scripts and
      // event handlers are unavoidable and must be allowed. Paystack's
      // inline.js is the only third-party script. Google Fonts CSS is inlined
      // by the stylesheet link; the font files come from gstatic.
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://js.paystack.co'],
      // The SPA uses inline event handlers (onclick etc.); helmet's default
      // `script-src-attr 'none'` would block every one of them, so inline is
      // allowed for handler attributes specifically.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://paystack.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'https:'],
      // API calls are same-origin; Paystack inline.js may open its own
      // connections and render the checkout in an iframe for popup flows even
      // though the app normally redirects to authorization_url.
      connectSrc: ["'self'", 'https://js.paystack.co', 'https://api.paystack.co'],
      frameSrc: ["'self'", 'https://checkout.paystack.com'],
      workerSrc: ["'self'"],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
      reportUri: '/api/admin/csp-report',
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Keep one canonical origin. Railway terminates TLS and forwards the original
// Host header, so redirect the optional www hostname before CORS, auth, static
// assets, or API middleware can handle the request.
app.use((req, res, next) => {
  const hostname = (req.get('host') || '').split(':', 1)[0].toLowerCase();
  if (hostname === 'www.topflowng.com') {
    return res.redirect(308, `https://topflowng.com${req.originalUrl}`);
  }
  next();
});

app.use(cors({
  origin: config.corsOrigin,
  credentials: true,
}));

// Raw body for Paystack webhook signature verification
app.use('/api/paystack/webhook', express.raw({ type: 'application/json' }));

// JSON body for everything else
app.use(express.json({ limit: config.bodyLimit }));
app.use(express.urlencoded({ extended: false }));

// Static files — a strict allow-list. The repository root is NOT exposed:
// only the whitelisted client assets below are served. Source code, env
// files, backups, node_modules and .git all remain private.
app.use(express.static(path.join(__dirname, 'public')));

const ROOT_ASSET_PATHS = new Set([
  '/topflowng.html',
  '/admin.html',
  '/bizflow.html',
  '/manifest.json',
  '/sw.js',
  '/robots.txt',
  '/sitemap.xml',
]);

// Far-future caching is reserved for inspect/versioned image assets only. The
// HTML shell, manifest and service worker are deliberately NOT immutable-cached
// (browsers must be able to re-fetch them to pick up revisions); API + private
// routes stay no-store so tokens/balances are never served stale.
app.use((req, res, next) => {
  const p = req.path;
  if (p.endsWith('.png') || p.endsWith('.jpg')
      || p.endsWith('.jpeg') || p.endsWith('.svg')
      || p.endsWith('.webp')) {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  } else if (p.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
});

app.use('/icons/:file', (req, res) => {
  const name = req.params.file;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return res.status(400).end();
  res.sendFile(path.join(__dirname, 'icons', name), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

// Public brand assets — only the dedicated provider/brand folders and the
// shared logo registry are exposed. Source notes and every other repository
// file remain private.
app.get('/assets/provider-logos.js', (_req, res) => {
  res.sendFile(path.join(__dirname, 'assets', 'provider-logos.js'), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});
app.get('/assets/:group/:file', (req, res) => {
  const { group, file } = req.params;
  if (!['providers', 'brand'].includes(group)
      || !/^[A-Za-z0-9._-]+\.(?:png|jpe?g|svg|webp)$/i.test(file)) {
    return res.status(404).end();
  }
  res.sendFile(path.join(__dirname, 'assets', group, file), (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use((req, res, next) => {
  if (ROOT_ASSET_PATHS.has(req.path)) {
    return res.sendFile(path.join(__dirname, req.path), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  }
  next();
});

// Hard-block private/source paths so they return 404 rather than falling
// through to the SPA shell: source files, env files, backups, node_modules,
// and .git are never exposed.
app.use((req, res, next) => {
  const url = req.path.toLowerCase();
  if (
    url.startsWith('/node_modules/') || url.startsWith('/.git') ||
    url.endsWith('.env') || url.includes('.env.') ||
    url.includes('.backup-') || url.endsWith('.bak') ||
    ['/package.json', '/package-lock.json', '/auth.js', '/server.js', '/database.js', '/config.js'].includes(url) ||
    /\.js$/.test(url) && !url.includes('sw.js')
  ) {
    return res.status(404).end();
  }
  next();
});

// ── Structured per-request log ───────────────────────────────────────────────
// Request ID (echoed as X-Request-Id), severity (level), route, status and
// duration. No request bodies/headers are ever logged; the shared logger
// additionally redacts any sensitive keys that a handler logs.
app.use((req, res, next) => {
  const requestId = crypto.randomBytes(8).toString('hex');
  req.id = requestId;
  res.setHeader('X-Request-Id', requestId);
  const startMs = Date.now();
  res.on('finish', () => {
    logger.info('http request', {
      requestId,
      method: req.method,
      route: req.originalUrl,
      status: res.statusCode,
      durationMs: Date.now() - startMs,
    });
  });
  next();
});

// ── Health Check (liveness) ──────────────────────────────────────────────────
// Pure liveness: the process is up and answering HTTP. Never includes
// configuration, versions, or database details.
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', ts: new Date().toISOString() });
});

// ── Readiness ────────────────────────────────────────────────────────────────
// Liveness plus dependency checks: reports ready only when the database is
// reachable. Distinguishes "process alive" (/api/health) from "able to serve
// traffic" (/api/ready). Deliberately leaks nothing about the database — the
// body only names the failing component.
app.get('/api/ready', async (_req, res) => {
  let probe;
  try {
    probe = await Promise.race([
      db.ping(),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false }), 2500)),
    ]);
  } catch {
    return res.status(503).json({ status: 'unready', component: 'database' });
  }
  if (probe && probe.ok) {
    return res.json({ status: 'ready', component: 'database', ts: new Date().toISOString() });
  }
  return res.status(503).json({ status: 'unready', component: 'database' });
});

// ── Provider health (read-only) ───────────────────────────────────────────────
// Lets the owned application run independently of the reseller frontend:
// reports whether the configured utility provider (VTPass) is reachable so the
// UI can degrade purchase flows gracefully. No secrets, no purchase, no raw
// provider bodies — only a status + latency, cached for a short window.
app.get('/api/providers/health', async (_req, res) => {
  try {
    const { healthCheck } = require('./providers/vtpass');
    const health = await healthCheck();
    const code = health.status === 'UNAVAILABLE' ? 503 : 200;
    return res.status(code).json({ provider: 'vtpass', ...health });
  } catch {
    return res.status(503).json({ provider: 'vtpass', status: 'UNAVAILABLE', reason: 'error' });
  }
});

// ── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', authLimiter, validate(registerSchema), async (req, res) => {
  try {
    const { fullName, email, phone, password, referralCode } = req.validated;

    const existing = await db.findUserByEmail(email);
    if (existing) return sendError(res, 409, 'Email already registered');

    const existingPhone = await db.findUserByPhone(phone.trim());
    if (existingPhone) return sendError(res, 409, 'Phone already registered');

    // Resolve referrer (optional — invalid codes are silently ignored)
    let referredBy = null;
    if (referralCode) {
      const referrer = await db.findUserByReferralCode(referralCode.trim().toUpperCase());
      if (referrer) referredBy = referrer.id;
    }

    const user  = await db.createUser({ fullName, email, phone: phone.trim(), password, referredBy });
    const token = jwt.sign({ id: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
    res.status(201).json({ token, user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, wallet: parseFloat(user.wallet), isAdmin: user.is_admin } });
  } catch (err) {
    logger.error('Register error', { message: err.message });
    if (err.code === '23505') return sendError(res, 409, 'Email or phone already registered');
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Registration failed');
  }
});

app.post('/api/auth/login', authLimiter, validate(loginSchema), async (req, res) => {
  try {
    const { email, password } = req.validated;

    if (security.isLockedOut(email)) {
      return sendError(res, 429, 'Too many failed attempts. Please try again in a few minutes.');
    }

    const user = await db.findUserByEmail(email);
    if (!user) {
      await security.recordLoginFailure(email);
      return sendError(res, 401, 'Invalid credentials');
    }

    const ok = await db.verifyPassword(user, password);
    if (!ok) {
      await security.recordLoginFailure(email);
      return sendError(res, 401, 'Invalid credentials');
    }

    security.resetLoginFailures(email);
    const token = jwt.sign({ id: user.id, email: user.email }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
    res.json({ token, user: { id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, wallet: parseFloat(user.wallet), isAdmin: user.is_admin } });
  } catch (err) {
    logger.error('Login error', { message: err.message });
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Login failed');
  }
});

app.post('/api/auth/forgot-password', authLimiter, validate(forgotPasswordSchema), async (req, res) => {
  try {
    const { email } = req.validated;

    const user = await db.findUserByEmail(email);
    // Always respond 200 to prevent user enumeration
    if (!user) {
      // Burn a work factor matching the real-path to blunt timing leaks.
      await new Promise((resolve) => bcrypt.compare('x', DUMMY_BCRYPT_HASH).then(resolve));
      return res.json({ message: 'If that email is registered, a reset link has been sent.' });
    }

    const token     = crypto.randomBytes(32).toString('hex');
    const resetUrl  = `${config.appUrl}/?reset=${token}`;
    await db.createPasswordReset(user.id, token);

    await sendEmail({
      to: user.email,
      subject: 'Reset your TopFlowNG password',
      html: `
        <p>Hi ${user.full_name},</p>
        <p>Click below to reset your password. This link expires in 1 hour.</p>
        <p><a href="${resetUrl}" style="background:#F5A623;color:#0E2235;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:bold;">Reset my password</a></p>
        <p>If you didn't request this, ignore this email.</p>
        <p>— TopFlowNG</p>
      `,
    });

    res.json({ message: 'If that email is registered, a reset link has been sent.' });
  } catch (err) {
    logger.error('Forgot password error', { message: err.message });
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to send reset email');
  }
});

app.post('/api/auth/reset-password', authLimiter, validate(resetPasswordSchema), async (req, res) => {
  try {
    const { token, password } = req.validated;

    await db.consumePasswordReset(token, password);
    res.json({ message: 'Password reset successfully. You can now log in.' });
  } catch (err) {
    if (err.message === 'Invalid or expired reset token')
      return sendError(res, 400, 'This reset link is invalid or has expired.');
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Password reset failed');
  }
});

app.post('/api/auth/change-password', authMiddleware, validate(changePasswordSchema), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.validated;

    const user = await db.findUserById(req.user.id);
    const fullUser = await db.findUserByEmail(user.email);
    const ok = await db.verifyPassword(fullUser, currentPassword);
    if (!ok) return sendError(res, 401, 'Current password is incorrect');

    await db.updateUserPassword(req.user.id, newPassword);
    res.json({ message: 'Password changed successfully.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to change password');
  }
});

app.post('/api/auth/logout', authMiddleware, async (req, res) => {
  security.revokeToken(req.token);
  res.json({ message: 'Logged out successfully.' });
});

// ── User Profile & Wallet ────────────────────────────────────────────────────
app.get('/api/user/profile', authMiddleware, async (req, res) => {
  try {
    const user = await db.findUserById(req.user.id);
    if (!user) return sendError(res, 404, 'User not found');
    res.json({ id: user.id, fullName: user.full_name, email: user.email, phone: user.phone, wallet: parseFloat(user.wallet), isAdmin: user.is_admin });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch profile');
  }
});

app.get('/api/wallet/balance', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const balance = await db.getWalletBalance(req.user.id);
    res.json({ balance });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch balance');
  }
});

app.get('/api/wallet/transactions', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const txns  = await db.getTransactions(req.user.id, limit);
    res.json({ transactions: txns });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch transactions');
  }
});

// ── Paystack ─────────────────────────────────────────────────────────────────
app.post('/api/paystack/initialize', authMiddleware, apiLimiter, validate(paystackInitSchema), async (req, res) => {
  try {
    const { amount } = req.validated;

    const user       = await db.findUserById(req.user.id);
    const amountKobo = Math.round(parseFloat(amount) * 100);
    const reference  = `TF-${Date.now()}-${req.user.id}`;

    const response = await axios.post(`${config.paystack.apiBaseUrl}/transaction/initialize`, {
      email: user.email,
      amount: amountKobo,
      reference,
      callback_url: `${config.appUrl}/?verified=${reference}`,
      metadata: { user_id: req.user.id, user_email: user.email },
    }, {
      headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
      timeout: config.paystack.timeoutMs,
    });

    res.json({ authorization_url: response.data.data.authorization_url, reference });
  } catch (err) {
    logger.error('Paystack init error', { message: err.response?.data ? JSON.stringify(err.response.data) : err.message });
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Payment initialization failed');
  }
});

async function getVerifiedPaystackPayment(reference) {
  const response = await axios.get(`${config.paystack.apiBaseUrl}/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
    timeout: config.paystack.timeoutMs,
  });
  const payment = response.data.data;
  if (payment.status !== 'success' || payment.reference !== reference) {
    const error = new Error('Paystack payment is not a verified successful charge');
    error.code = 'PAYMENT_NOT_SUCCESSFUL';
    throw error;
  }
  const userId = payment.metadata?.user_id;
  if (!userId) {
    const error = new Error(`Verified Paystack payment ${reference} has no user_id metadata`);
    error.code = 'PAYMENT_USER_MISSING';
    throw error;
  }
  return { userId: Number(userId), amount: payment.amount / 100 };
}

function monitorUncreditedPaystackPayment(reference) {
  setTimeout(async () => {
    try {
      if (!await db.paystackRefExists(reference)) {
        logger.error(`ALERT: verified Paystack payment ${reference} is still uncredited after 60 seconds`);
      }
    } catch (err) {
      logger.error(`ALERT: unable to check Paystack credit state for ${reference}`, { message: err.message });
    }
  }, 60_000).unref();
}

async function verifyAndCreditPaystackPayment(reference, expectedUserId = null) {
  const payment = await getVerifiedPaystackPayment(reference);
  if (expectedUserId && payment.userId !== Number(expectedUserId)) {
    const error = new Error('Payment does not belong to the authenticated user');
    error.code = 'PAYMENT_USER_MISMATCH';
    throw error;
  }
  monitorUncreditedPaystackPayment(reference);
  const result = await db.creditVerifiedPaystackPayment(reference, payment.userId, payment.amount);
  logger.info(`Paystack payment ${result.credited ? 'credited' : 'already credited'}: user ${payment.userId} +₦${payment.amount} [${reference}]`);
  if (reference.startsWith('AR-')) {
    await db.completeAutoRechargeSession(reference).catch(() => {});
  }
  return { ...result, userId: payment.userId };
}

app.get('/api/paystack/verify/:reference', authMiddleware, async (req, res) => {
  try {
    const result = await verifyAndCreditPaystackPayment(req.params.reference, req.user.id);
    res.json({ success: true, balance: result.balance, credited: result.credited });
  } catch (err) {
    logger.error('Paystack verify error', { message: err.response?.data ? JSON.stringify(err.response.data) : err.message });
    if (config.sentry.dsn) Sentry.captureException(err);
    const status = ['PAYMENT_NOT_SUCCESSFUL', 'PAYMENT_USER_MISMATCH'].includes(err.code) ? 400 : 500;
    sendError(res, status, 'Payment verification failed');
  }
});

// Constant-time signature comparison for the Paystack webhook. The expected
// digest is always a 64-byte hex string (HMAC-SHA512), so a valid header must
// be exactly that length. Missing, malformed (non-hex), or wrong-length
// signatures short-circuit to false without ever reaching timingSafeEqual
// (which requires equal-length buffers and would throw otherwise).
function paystackSignatureMatches(expectedHex, signatureHex) {
  const CH = /^[0-9a-fA-F]{128}$/;
  if (typeof signatureHex !== 'string' || !CH.test(signatureHex)) return false;
  const expected = Buffer.from(expectedHex, 'hex');
  const presented = Buffer.from(signatureHex, 'hex');
  return crypto.timingSafeEqual(expected, presented);
};

// In-memory webhook retry queue with exponential backoff.
const webhookRetries = new Map(); // reference -> { attempts, nextRetryAt }

app.post('/api/paystack/webhook', async (req, res) => {
  try {
    const secret    = config.paystack.webhookSecret || config.paystack.secretKey;
    const signature = req.headers['x-paystack-signature'];
    const hash      = crypto.createHmac('sha512', secret).update(req.body).digest('hex');

    if (!paystackSignatureMatches(hash, signature)) {
      logger.warn('Invalid Paystack webhook signature');
      return sendError(res, 400, 'Invalid signature');
    }

    const event = JSON.parse(req.body.toString());

    if (event.event === 'charge.success') {
      await verifyAndCreditPaystackPayment(event.data.reference);
    }

    res.sendStatus(200);
  } catch (err) {
    logger.error('Webhook error', { message: err.message });
    // Queue for retry with exponential backoff: 30s, 2min, 8min, 32min
    try {
      const event = JSON.parse(req.body.toString());
      if (event.event === 'charge.success' && event.data?.reference) {
        const ref = event.data.reference;
        const existing = webhookRetries.get(ref);
        const attempts = (existing?.attempts || 0) + 1;
        const delayMs = Math.min(30000 * Math.pow(4, attempts - 1), 30 * 60 * 1000);
        webhookRetries.set(ref, { attempts, nextRetryAt: Date.now() + delayMs });
        logger.info('Webhook queued for retry', { reference: ref, attempt: attempts, delayMs });
      }
    } catch { /* best-effort queue */ }
    if (config.sentry.dsn) Sentry.captureException(err);
    res.sendStatus(200);
  }
});

// Retry failed webhooks in the sweeper interval.
async function processWebhookRetries() {
  const now = Date.now();
  for (const [ref, entry] of webhookRetries) {
    if (entry.nextRetryAt > now) continue;
    try {
      await verifyAndCreditPaystackPayment(ref);
      webhookRetries.delete(ref);
      logger.info('Webhook retry succeeded', { reference: ref });
    } catch (err) {
      entry.attempts += 1;
      const delayMs = Math.min(30000 * Math.pow(4, entry.attempts - 1), 30 * 60 * 1000);
      entry.nextRetryAt = Date.now() + delayMs;
      if (entry.attempts >= 6) {
        logger.error('Webhook retry exhausted', { reference: ref, attempts: entry.attempts });
        webhookRetries.delete(ref);
      }
    }
  }
}

// ── VTU Routes (mounted /api/vtu/*) ──────────────────────────────────────────
// User-facing order status. Lets the app resolve a purchase quickly: if the
// order is still pending and traceable, it triggers an immediate provider
// query (throttled by reconcilePollCooldownMs) instead of making the user wait
// for the background sweeper. Registered BEFORE the purchase-limiter mount so
// rapid status polling never trips the 10 req/min purchase bucket. Exactly-once
// settlement is unchanged — the same reconcileVtuOrder path (row lock +
// terminal-state guard) is used.
app.get('/api/vtu/orders/:requestId', authMiddleware, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  try {
    const order = await db.getVtuOrderByRequestId(requestId);
    if (!order || String(order.user_id) !== String(req.user.id)) {
      return sendError(res, 404, 'VTU order not found');
    }

    let current = order;
    if (order.status === 'pending' && order.provider_order_id) {
      const lastReconciled = order.last_reconciled_at
        ? new Date(order.last_reconciled_at).getTime()
        : 0;
      const cooldownMs = config.vtpass.reconcilePollCooldownMs;
      if (Date.now() - lastReconciled >= cooldownMs) {
        try {
          await reconcileVtuOrder(requestId);
          current = await db.getVtuOrderByRequestId(requestId) || order;
        } catch (err) {
          logger.error(`On-demand VTU reconcile failed for ${requestId}`, { message: err.message });
        }
      }
    }

    const body = {
      requestId: current.request_id,
      status: current.status,
      serviceType: current.service_type,
      amount: Number(current.amount),
      description: current.description,
      providerOrderId: current.provider_order_id || null,
      providerStatus: current.provider_status || null,
      providerRemark: current.provider_remark || null,
      message: current.status === 'pending'
        ? 'Your request is pending provider confirmation. Your wallet has not been debited.'
        : current.status === 'failed'
          ? 'The provider did not confirm this order. Your wallet has not been debited.'
          : 'This order was completed and your wallet was debited once.',
    };
    res.json(body);
  } catch (err) {
    logger.error('VTU order status lookup failed', { requestId, message: err.message });
    sendError(res, 500, 'Failed to check this order');
  }
});

// Purchase rate limiter (per-user, default 10 req/min) applies to all VTU
// purchase endpoints — airtime, data, cable, electricity, exam, recharge pins.
app.use('/api/vtu', purchaseLimiter, vtuRouter);

// ── AI Assistant (mounted /api/ai/*) — read-only, advisory ─────────────────
app.use('/api/ai', aiRouter);

// ── VTPass VTU Reconciliation ───────────────────────────────────────────────
// VTPass identifies a transaction solely by the request_id we sent, so every
// captured pending order is queryable via /requery — no provider-side order id
// is needed. Uses the provider's documented requery and never trusts a browser
// claim or a stale initial response. Shared by the admin endpoint and the
// background sweeper so both apply identical, exactly-once settlement
// semantics. Unknown request_ids (e.g. legacy Clubkonnect-era rows) come back
// as 015 INVALID REQUEST ID, which normalises to 'failed' — a clean, honest
// terminal state for orders the current provider never actually accepted.
async function reconcileVtuOrder(requestId) {
  const order = await db.getVtuOrderByRequestId(requestId);
  if (!order) return { error: 'VTU order not found' };
  if (order.status !== 'pending') {
    return { outcome: order.status, order, message: 'This order is already in a terminal state.' };
  }
  if (!order.request_id) {
    return {
      outcome: 'unqueryable',
      order,
      message: 'This pending order has no request reference and cannot be queried.',
    };
  }

  await db.recordReconciliationAttempt(requestId);
  const provider = await queryVtpassOrder(order.request_id);
  await db.recordVtuProviderResponse(requestId, provider);

  let balance = null;
  if (provider.outcome === 'success') {
    const settled = await db.completeVtuOrder(requestId, { allowPending: true });
    balance = settled.balance;
    logger.info('VTPass pending order settled', { requestId });
  } else if (provider.outcome === 'failed') {
    await db.markVtuOrderFailed(requestId, { allowPending: true });
    logger.warn('VTPass pending order failed on reconciliation', { requestId });
  } else {
    logger.info('VTPass pending order remains pending', { requestId });
  }

  const updated = await db.getVtuOrderByRequestId(requestId);
  return {
    outcome: provider.outcome,
    order: updated,
    balance,
    message: provider.outcome === 'pending'
      ? 'VTPass still reports this order as pending. No wallet debit was made.'
      : provider.outcome === 'success'
        ? 'VTPass confirmed delivery and the wallet was debited once.'
        : 'VTPass confirmed failure. No wallet debit was made.',
  };
}

// Admin-only manual reconciliation.
app.post('/api/admin/vtu-orders/:requestId/reconcile', adminMiddleware, async (req, res) => {
  const requestId = String(req.params.requestId || '').trim();
  try {
    const result = await reconcileVtuOrder(requestId);
    if (result.error) return sendError(res, 404, result.error);
    if (result.outcome === 'unqueryable') {
      return res.status(409).json({ error: result.message, order: result.order });
    }
    res.json(result);
  } catch (err) {
    logger.error(`VTPass reconciliation error for ${requestId}`, { message: err.message });
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 502, 'Unable to reconcile this provider order right now.');
  }
});

// ── Admin Routes ─────────────────────────────────────────────────────────────
app.get('/api/admin/stats', adminMiddleware, async (req, res) => {
  try {
    const stats = await db.getAdminStats();
    res.json(stats);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch stats');
  }
});

app.get('/api/admin/transactions', adminMiddleware, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const type   = String(req.query.type || '').trim() || undefined;
    const status = String(req.query.status || '').trim() || undefined;
    const q      = String(req.query.q || '').trim() || undefined;
    const from   = req.query.from || undefined;
    const to     = req.query.to || undefined;
    const result = await db.getAllTransactions({ limit, offset, type, status, q, from, to });
    res.json(result);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch transactions');
  }
});

app.get('/api/admin/users', adminMiddleware, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const q      = String(req.query.q || '').trim() || undefined;
    const result = await db.getAllUsers({ limit, offset, q });
    res.json(result);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch users');
  }
});

app.get('/api/admin/vtu-orders', adminMiddleware, async (req, res) => {
  try {
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const status = String(req.query.status || '').trim() || undefined;
    const q      = String(req.query.q || '').trim() || undefined;
    const result = await db.getAdminVtuOrders({ limit, offset, status, q });
    res.json(result);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, err.message || 'Failed to fetch VTU orders');
  }
});

app.get('/api/admin/transactions/export', adminMiddleware, async (req, res) => {
  try {
    const q    = String(req.query.q || '').trim() || undefined;
    const from = req.query.from || undefined;
    const to   = req.query.to || undefined;
    const result = await db.getAllTransactions({ limit: 5000, offset: 0, q, from, to });
    const txns = result.transactions;
    const header = 'id,type,amount,description,reference,status,user_name,user_email,created_at\n';
    const rows = txns.map(t =>
      [t.id, t.type, t.amount, `"${(t.description||'').replace(/"/g,'""')}"`,
       t.reference||'', t.status||'completed',
       `"${(t.user_name||'').replace(/"/g,'""')}"`,
       `"${(t.user_email||'').replace(/"/g,'""')}"`, t.created_at].join(',')
    ).join('\n');
    const csv = '\uFEFF' + header + rows; // BOM for Excel
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="transactions-${Date.now()}.csv"`);
    res.send(csv);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to export transactions');
  }
});

app.get('/api/admin/reconciliation', adminMiddleware, async (req, res) => {
  try {
    const data = await db.getFinancialReconciliation();
    res.json(data);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to run reconciliation');
  }
});

// CSP violation reporting endpoint (receives report-only violations for monitoring)
app.post('/api/admin/csp-report', apiLimiter, express.json({ type: 'application/reports+json' }), (req, res) => {
  const body = req.body;
  if (body && body['csp-report']) {
    logger.warn('CSP violation', {
      blocked: body['csp-report']['blocked-uri'],
      directive: body['csp-report']['violated-directive'],
      document: body['csp-report']['document-uri'],
    });
  } else if (body && Array.isArray(body)) {
    body.forEach(r => {
      if (r.body && r.body['csp-report']) {
        logger.warn('CSP violation (report-to)', {
          blocked: r.body['csp-report']['blocked-uri'],
          directive: r.body['csp-report']['violated-directive'],
        });
      }
    });
  }
  res.sendStatus(204);
});

// ── Transaction PIN ──────────────────────────────────────────────────────────
app.post('/api/auth/reset-transaction-pin', authMiddleware, validate(resetPinSchema), async (req, res) => {
  try {
    const { currentPassword, newPin } = req.validated;
    const user = await db.findUserById(req.user.id);
    const fullUser = await db.findUserByEmail(user.email);
    const ok = await db.verifyPassword(fullUser, currentPassword);
    if (!ok) return sendError(res, 401, 'Current password is incorrect');
    await db.setTransactionPin(req.user.id, newPin);
    res.json({ message: 'Transaction PIN reset successfully.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to reset PIN');
  }
});

app.post('/api/auth/set-transaction-pin', authMiddleware, validate(setPinSchema), async (req, res) => {
  try {
    const { pin } = req.validated;
    await db.setTransactionPin(req.user.id, pin);
    res.json({ message: 'Transaction PIN set successfully.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to set PIN');
  }
});

app.post('/api/auth/verify-transaction-pin', authMiddleware, validate(verifyPinSchema), async (req, res) => {
  try {
    const { pin } = req.validated;
    const valid = await db.verifyTransactionPin(req.user.id, pin);
    res.json({ valid });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to verify PIN');
  }
});

app.get('/api/auth/pin-status', authMiddleware, async (req, res) => {
  try {
    const hasPin = await db.hasTransactionPin(req.user.id);
    res.json({ hasPin });
  } catch (err) {
    sendError(res, 500, 'Failed to check PIN status');
  }
});

// ── Beneficiaries ─────────────────────────────────────────────────────────────
app.get('/api/beneficiaries', authMiddleware, async (req, res) => {
  try {
    const list = await db.getBeneficiaries(req.user.id);
    res.json({ beneficiaries: list });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch beneficiaries');
  }
});

app.post('/api/beneficiaries', authMiddleware, validate(beneficiaryAddSchema), async (req, res) => {
  try {
    const { type, label, network, identifier } = req.validated;
    const b = await db.addBeneficiary(req.user.id, { type, label, network, identifier });
    res.json({ beneficiary: b });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to save beneficiary');
  }
});

app.delete('/api/beneficiaries/:id', authMiddleware, async (req, res) => {
  try {
    const deleted = await db.deleteBeneficiary(req.user.id, parseInt(req.params.id));
    if (!deleted) return sendError(res, 404, 'Beneficiary not found');
    res.json({ message: 'Deleted.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to delete beneficiary');
  }
});

// ── BizFlow user data (per-user JSONB document) ─────────────────────────────
// The business suite persists invoices/clients/staff/payroll as one document
// and can outgrow the default 10kb body limit, so this route parses its own.
app.put('/api/bizflow/data', authMiddleware, express.json({ limit: '1mb' }), async (req, res) => {
  try {
    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return sendError(res, 400, 'Expected a bizflow data document');
    }
    await db.saveBizflowData(req.user.id, data);
    res.json({ saved: true });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to save bizflow data');
  }
});

app.get('/api/bizflow/data', authMiddleware, async (req, res) => {
  try {
    const data = await db.getBizflowData(req.user.id);
    res.json({ data });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch bizflow data');
  }
});

// Send a BizFlow invoice to the client by email. Looks the invoice up in the
// user's persisted document, requires the linked client to have an email,
// delivers via the configured provider, and marks the invoice 'sent'.
app.post('/api/bizflow/invoices/:id/send', authMiddleware, async (req, res) => {
  try {
    const data = await db.getBizflowData(req.user.id);
    const invoices = Array.isArray(data?.invoices) ? data.invoices : [];
    const clients = Array.isArray(data?.clients) ? data.clients : [];
    const inv = invoices.find(i => String(i.id) === String(req.params.id));
    if (!inv) return sendError(res, 404, 'Invoice not found');
    const client = clients.find(c => String(c.id) === String(inv.clientId));
    const clientEmail = (client?.email || inv.clientEmail || '').trim();
    if (!clientEmail) return sendError(res, 400, 'The linked client has no email address on file');

    const user = await db.findUserById(req.user.id);
    await sendInvoiceEmail(clientEmail, {
      invoice: inv,
      client: client || { name: inv.clientName },
      ownerName: user.full_name,
      ownerCompany: 'TopFlowNG BizFlow',
    });

    if (inv.status !== 'paid') inv.status = 'sent';
    await db.saveBizflowData(req.user.id, data);
    res.json({ message: 'Invoice sent.', status: inv.status });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to send invoice');
  }
});

// ── Referral ──────────────────────────────────────────────────────────────────
app.get('/api/referral', authMiddleware, async (req, res) => {
  try {
    const stats = await db.getReferralStats(req.user.id);
    res.json(stats);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch referral info');
  }
});

// ── Analytics Summary ─────────────────────────────────────────────────────────
app.get('/api/analytics/summary', authMiddleware, async (req, res) => {
  try {
    const summary = await db.getAnalyticsSummary(req.user.id);
    res.json(summary);
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch analytics');
  }
});

// ── Auto-recharge ────────────────────────────────────────────────────────────
app.get('/api/auto-recharge', authMiddleware, async (req, res) => {
  try {
    const settings = await db.getAutoRecharge(req.user.id);
    res.json({ settings: settings || null });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch auto-recharge settings');
  }
});

app.get('/api/auto-recharge/pending', authMiddleware, async (req, res) => {
  try {
    const session = await db.getPendingAutoRechargeSession(req.user.id);
    res.json({ session: session || null });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch pending auto-recharge');
  }
});

app.post('/api/auto-recharge', authMiddleware, apiLimiter, validate(autoRechargeSchema), async (req, res) => {
  try {
    const { threshold, amount } = req.validated;
    const settings = await db.setAutoRecharge(req.user.id, { threshold, amount });
    res.json({ settings, message: 'Low-balance reminder enabled. A Paystack checkout will be created below ₦' + threshold + '; nothing is charged automatically.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to set auto-recharge');
  }
});

app.delete('/api/auto-recharge', authMiddleware, async (req, res) => {
  try {
    await db.deleteAutoRecharge(req.user.id);
    res.json({ message: 'Auto-recharge disabled.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to disable auto-recharge');
  }
});

// ── Scheduled purchases ──────────────────────────────────────────────────────
app.get('/api/scheduled-purchases', authMiddleware, async (req, res) => {
  try {
    const list = await db.getScheduledPurchases(req.user.id);
    res.json({ scheduled: list });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to fetch scheduled purchases');
  }
});

app.post('/api/scheduled-purchases', authMiddleware, apiLimiter, validate(scheduledPurchaseSchema), async (req, res) => {
  try {
    const { serviceType, planCode, phone, identifier, network, amount, frequency, nextRunAt, pin } = req.validated;
    await checkTransactionPin(req.user.id, pin);

    // A schedule is a future debit, so the same server-side pricing rules that
    // guard the interactive routes must apply here. Otherwise a schedule could
    // be stored with a ₦1 amount against a ₦4,000 plan and the sweeper would
    // deliver the plan while debiting ₦1.
    if (serviceType === 'data') {
      if (!planCode) return sendError(res, 400, 'planCode is required for data schedules');
      try { validatePlanAmount(network, planCode, amount); }
      catch (e) { return sendError(res, 400, e.message); }
    } else if (serviceType === 'cable') {
      if (!planCode) return sendError(res, 400, 'planCode is required for cable schedules');
      try { validateCablePlanAmount(network, planCode, amount); }
      catch (e) { return sendError(res, 400, e.message); }
    } else if (serviceType === 'airtime') {
      if (!phone) return sendError(res, 400, 'phone is required for airtime schedules');
    } else if (serviceType === 'electricity') {
      if (!identifier) return sendError(res, 400, 'identifier (meter number) is required for electricity schedules');
    }

    const purchase = await db.createScheduledPurchase(req.user.id, {
      serviceType, planCode, phone, identifier, network, amount, frequency,
      nextRunAt: new Date(nextRunAt),
    });
    res.status(201).json({ purchase, message: 'Purchase scheduled.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to schedule purchase');
  }
});

app.delete('/api/scheduled-purchases/:id', authMiddleware, async (req, res) => {
  try {
    const deleted = await db.deleteScheduledPurchase(req.user.id, parseInt(req.params.id));
    if (!deleted) return sendError(res, 404, 'Scheduled purchase not found');
    res.json({ message: 'Scheduled purchase cancelled.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to cancel scheduled purchase');
  }
});

app.patch('/api/scheduled-purchases/:id/status', authMiddleware, apiLimiter, async (req, res) => {
  try {
    if (typeof req.body?.active !== 'boolean') return sendError(res, 400, 'active must be true or false');
    const purchase = await db.setScheduledPurchaseActive(req.user.id, parseInt(req.params.id), req.body.active);
    if (!purchase) return sendError(res, 404, 'Scheduled purchase not found');
    res.json({ purchase, message: req.body.active ? 'Scheduled purchase resumed.' : 'Scheduled purchase paused.' });
  } catch (err) {
    if (config.sentry.dsn) Sentry.captureException(err);
    sendError(res, 500, 'Failed to update scheduled purchase');
  }
});

// Unknown API routes must never masquerade as a successful SPA document.
app.all('/api/*', (req, res) => sendError(res, 404, 'API route not found'));

// ── SPA Fallback ─────────────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'topflowng.html'));
});

// ── Sentry Error Handler ─────────────────────────────────────────────────────
if (config.sentry.dsn) {
  Sentry.setupExpressErrorHandler(app);
}

// ── Global Error Handler ─────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  logger.error('Unhandled error', { message: err.message });
  sendError(res, 500, 'Internal server error');
});

// ── Start Server ─────────────────────────────────────────────────────────────
function schedulePendingOrderSweep() {
  if (typeof db.expireStaleVtuOrders !== 'function') return null;
  if (typeof db.getReconcilablePendingOrders !== 'function') return null;
  const expiryMinutes = config.vtpass.pendingOrderExpiryMinutes;
  const intervalMs = config.vtpass.sweepIntervalMs;
  const backoffMinutes = config.vtpass.reconcileBackoffMinutes;
  const maxAttempts = config.vtpass.reconcileMaxAttempts;
  let timer = null;

  async function processDueAutoRecharges() {
    try {
      const due = await db.getDueAutoRecharges(10);
      for (const row of due) {
        logger.info('Processing auto-recharge', { userId: row.user_id, amount: row.amount });
        try {
          const reference = `AR-${Date.now()}-${row.user_id}`;
          const response = await axios.post(`${config.paystack.apiBaseUrl}/transaction/initialize`, {
            email: row.email,
            amount: Math.round(parseFloat(row.amount) * 100),
            reference,
            callback_url: `${config.appUrl}/?verified=${reference}`,
            metadata: { user_id: row.user_id, auto_recharge: true },
          }, {
            headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
            timeout: config.paystack.timeoutMs,
          });
          const authorizationUrl = response.data?.data?.authorization_url;
          logger.info('Auto-recharge initiated', { userId: row.user_id, ref: reference });

          // Persist the checkout session so the user can complete the top-up from
          // the account screen too (in-app fallback beyond the email link).
          if (authorizationUrl) {
            await db.createAutoRechargeSession(row.user_id, {
              reference,
              authorizationUrl,
              amount: row.amount,
            });
          }

          // Tell the user how to complete the top-up. Credits arrive via the
          // Paystack webhook/verify path just like a normal funding.
          await sendAutoRechargeEmail(row.email, row.full_name, {
            amount: row.amount, threshold: row.threshold,
            authorizationUrl, reference,
          });

          // Record the trigger so the sweeper does not re-initialise another
          // payment for the same low-balance pocket until the cooldown elapses.
          await db.markAutoRechargeTriggered(row.user_id);
        } catch (err) {
          logger.error('Auto-recharge failed', { userId: row.user_id, message: err.message });
          await db.pool.query(
            'UPDATE auto_recharges SET failed_attempts = failed_attempts + 1 WHERE user_id = $1',
            [row.user_id]
          ).catch(() => {});
        }
      }
    } catch (err) {
      logger.error('Auto-recharge sweep failed', { message: err.message });
    }
  }

  function computeNextRun(frequency, from) {
    const d = new Date(from);
    if (frequency === 'daily') d.setDate(d.getDate() + 1);
    else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
    else if (frequency === 'monthly') d.setMonth(d.getMonth() + 1);
    else return null;
    return d;
  }

  // Scheduled purchases ship as VTPass products via the shared provider client
  // and VTPass-format request ids (YYYYMMDDHHII + suffix), so the sweeper and
  // the interactive routes use the same idempotency + reconciliation paths.
  const { buildRequestId, productFor } = require('./services/vtpass');

  function buildScheduledPurchaseProduct(row) {
    const requestId = buildRequestId();
    const serviceType = row.service_type;
    switch (serviceType) {
      case 'airtime':
        return { requestId, product: productFor('airtime', { network: row.network, phone: row.phone, amount: Number(row.amount) }) };
      case 'data':
        if (!row.plan_code) throw new Error('Data plan code missing');
        return { requestId, product: productFor('data', { network: row.network, planCode: row.plan_code, phone: row.phone }) };
      case 'cable':
        if (!row.plan_code) throw new Error('Cable package code missing');
        return { requestId, product: productFor('cable', { provider: String(row.network || ''), planCode: row.plan_code, smartCardNumber: row.identifier, phone: '' }) };
      case 'electricity':
        return { requestId, product: productFor('electricity', { disco: String(row.network || ''), meterType: 'prepaid', meterNumber: row.identifier, amount: Number(row.amount), phone: '' }) };
      default:
        throw new Error(`Unsupported service type: ${serviceType}`);
    }
  }

  async function processDueScheduledPurchases() {
    try {
      const due = await db.getDueScheduledPurchases(20);
      for (const row of due) {
        await db.withScheduledPurchaseLock(row.id, async () => {
          try {
            if (parseFloat(row.wallet) < parseFloat(row.amount)) {
              logger.warn('Scheduled purchase skipped — insufficient balance', { id: row.id, userId: row.user_id });
              return;
            }
            logger.info('Processing scheduled purchase', { id: row.id, serviceType: row.service_type });
            const built = buildScheduledPurchaseProduct(row);
            const requestId = await db.getOrCreateScheduledReference(row.id, built.requestId);
            if (!requestId) return;
            const existing = await db.getVtuOrderByRequestId(requestId);
            const result = existing && ['completed', 'pending', 'failed'].includes(existing.status)
              ? { outcome: existing.status === 'completed' ? 'success' : existing.status, balance: Number(row.wallet) }
              : await processVtpassPurchase({
                userId: row.user_id, requestId, serviceType: row.service_type,
                amount: Number(row.amount), description: `${row.service_type} — ${row.phone || row.identifier}`, product: built.product,
              });

          const nextRun = row.frequency === 'once' ? null : computeNextRun(row.frequency, new Date());
          if (result.outcome === 'success') {
            sendPurchaseEmail(row.email, row.full_name, {
              service: row.service_type, description: `${row.service_type} — ${row.phone || row.identifier}`,
              amount: Number(row.amount), reference: requestId, newBalance: result.balance,
            });
          } else if (result.outcome === 'pending') {
            sendOrderStatusEmail(row.email, row.full_name, {
              service: row.service_type, description: `${row.service_type} — ${row.phone || row.identifier}`,
              amount: Number(row.amount), requestId, status: 'pending',
            });
          } else {
            sendOrderStatusEmail(row.email, row.full_name, {
              service: row.service_type, description: `${row.service_type} — ${row.phone || row.identifier}`,
              amount: Number(row.amount), requestId, status: 'failed',
            });
          }

          // Advance the schedule on success/pending so it does not re-fire on
          // every sweep. One-off schedules are recorded and then disabled.
          if (nextRun) {
            await db.recordScheduledRun(row.id, nextRun);
          } else {
            await db.disableScheduledPurchase(row.id);
          }
          logger.info('Scheduled purchase executed', { id: row.id, outcome: result.outcome, requestId });
          } catch (err) {
            logger.error('Scheduled purchase failed', { id: row.id, message: err.message });
          }
        });
      }
    } catch (err) {
      logger.error('Scheduled purchase sweep failed', { message: err.message });
    }
  }

  async function sweep() {
    try {
      // 0) Rescue pending orders whose raw provider response carried a reference
      // that the old normaliser failed to capture (ordernumber/OrderNumber/etc).
      // Must run BEFORE the expirer below so recoverable orders are re-traced
      // (and eligible for reconcile) instead of being swept to 'failed'.
      const backfilled = await db.backfillVtuOrderProviderIds({ limit: 50 });
      if (backfilled.recovered > 0) {
        logger.info('Backfilled provider references for pending orders', backfilled);
      }

      // 1) Auto-expire unconfirmed orders that never got a provider reference.
      const expiry = await db.expireStaleVtuOrders({ olderThanMinutes: expiryMinutes });
      if (expiry.expired > 0) {
        logger.info('Auto-expired unconfirmed pending orders', { expired: expiry.expired, scanned: expiry.scanned });
        // Notify users whose orders were expired (wallet never debited).
        for (const order of expiry.orders || []) {
          db.findUserById(order.user_id).then(user => {
            if (!user) return;
            sendOrderStatusEmail(user.email, user.full_name, {
              service: order.service_type, description: order.description,
              amount: order.amount, requestId: order.request_id, status: 'failed',
            });
          }).catch(() => {});
        }
      }

      // 1.5) Clean up stuck 'submitted' orders that never progressed (pre-idempotency
      // legacy artifacts or interrupted flows). These have no transaction_id and
      // no provider_order_id — they were never debited. Move to failed after 24h.
      try {
        const staleSubmitted = await db.cleanStaleSubmittedOrders({ olderThanHours: 24 });
        if (staleSubmitted > 0) {
          logger.info('Cleaned stale submitted orders', { cleaned: staleSubmitted });
        }
      } catch (err) {
        logger.error('Failed to clean stale submitted orders', { message: err.message });
      }

      // 3) Process due auto-recharges (wallet below threshold).
      await processDueAutoRecharges();

      // 4) Process due scheduled purchases.
      await processDueScheduledPurchases();

      // 5) Retry failed Paystack webhook verifications.
      await processWebhookRetries();

      // 2) Auto-reconcile traceable pending orders via the provider Query API.
      const reconcilable = await db.getReconcilablePendingOrders({
        backoffMinutes,
        maxAttempts,
        limit: 20,
      });
      for (const row of reconcilable) {
        try {
          const result = await reconcileVtuOrder(row.request_id);
          if (result.outcome === 'success') {
            logger.info('Sweep settled pending order', { requestId: row.request_id });
            db.findUserById(result.order.user_id).then(user => {
              if (!user) return;
              sendOrderStatusEmail(user.email, user.full_name, {
                service: result.order.service_type, description: result.order.description,
                amount: result.order.amount, requestId: result.order.request_id,
                status: 'completed', newBalance: result.balance,
              });
            }).catch(() => {});
          } else if (result.outcome === 'failed') {
            logger.warn('Sweep marked pending order failed', { requestId: row.request_id });
            db.findUserById(result.order.user_id).then(user => {
              if (!user) return;
              sendOrderStatusEmail(user.email, user.full_name, {
                service: result.order.service_type, description: result.order.description,
                amount: result.order.amount, requestId: result.order.request_id, status: 'failed',
              });
            }).catch(() => {});
          }
        } catch (err) {
          logger.error('Sweep reconcile failed', { requestId: row.request_id, message: err.message });
        }
      }
    } catch (err) {
      logger.error('Pending order sweep failed', { message: err.message });
    }
  }

  // Run once shortly after boot so already-stale orders (e.g. from a deploy
  // without the sweeper) are cleaned immediately, then every interval.
  const firstRun = setTimeout(() => { sweep(); }, 3000);
  firstRun.unref();
  timer = setInterval(sweep, intervalMs);
  timer.unref();
  scheduledProcessorHooks.processDueScheduledPurchases = processDueScheduledPurchases;
  scheduledProcessorHooks.computeNextRun = computeNextRun;
  scheduledProcessorHooks.processDueAutoRecharges = processDueAutoRecharges;
  return timer;
}

async function start() {
  await db.initDB();
  const server = app.listen(PORT, '0.0.0.0', () => {
    logger.info('TopFlowNG server started', { port: PORT, env: config.env });
  });
  server.on('error', (err) => {
    logger.error('Server error', { message: err.message });
  });

  const sweepTimer = schedulePendingOrderSweep();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down', { signal });
    const forceTimer = setTimeout(() => {
      logger.warn('Graceful shutdown timed out; forcing exit');
      process.exit(1);
    }, 15000);
    forceTimer.unref();
    try {
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
      if (sweepTimer) clearInterval(sweepTimer);
      await new Promise((resolve) => server.close(resolve));
      if (typeof db.closePool === 'function') await db.closePool().catch(() => {});
      logger.info('Shutdown complete');
      process.exit(0);
    } catch (err) {
      logger.error('Error during shutdown', { message: err.message });
      process.exit(1);
    }
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((err) => {
  logger.error('Failed to start server', { message: err.message });
  process.exit(1);
});

// Exported for tests that need to exercise the reconciliation and scheduled
// purchase paths directly against the real database (test/lifecycle.test.js).
const scheduledProcessorHooks = {};
module.exports = { reconcileVtuOrder, scheduledProcessorHooks };
