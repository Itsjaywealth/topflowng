/**
 * TopFlowNG — Centralised configuration.
 *
 * Every environment variable is read and validated here. Fail-fast in
 * production when a required secret is missing; development/test fall back to
 * safe defaults so the app can still boot for local work and automated checks.
 * Secrets are never logged or exposed to the frontend.
 */

'use strict';

require('dotenv').config();

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function str(value, fallback) {
  return value === undefined || value === '' ? fallback : String(value);
}

function requireSecret(name) {
  const value = process.env[name];
  if (value && value.trim()) return value.trim();
  if (isProduction) {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  console.warn(`[config] ${name} is not set; using a development fallback`);
  return null;
}

const config = {
  env: NODE_ENV,
  isProduction,
  isDevelopment: NODE_ENV === 'development',

  port: num(process.env.PORT, 3000),
  appUrl: str(process.env.APP_URL, 'https://topflowng.com'),
  corsOrigin: str(process.env.APP_URL, '*'),
  trustProxy: str(process.env.TRUST_PROXY, '1') === '1',
  bodyLimit: str(process.env.BODY_LIMIT, '10kb'),

  jwt: {
    secret: requireSecret('JWT_SECRET') || 'dev-insecure-jwt-secret-change-me',
    expiresIn: str(process.env.JWT_EXPIRES_IN, '7d'),
  },

  rateLimit: {
    authWindowMs: num(process.env.AUTH_RATE_WINDOW_MS, 15 * 60 * 1000),
    authMax: num(process.env.AUTH_RATE_MAX, 10),
    apiWindowMs: num(process.env.API_RATE_WINDOW_MS, 60 * 1000),
    apiMax: num(process.env.API_RATE_MAX, 60),
  },

  auth: {
    // Repeated login failures within the window trigger a temporary lockout.
    loginMaxFailures: num(process.env.AUTH_LOCKOUT_MAX_FAILURES, 5),
    lockoutWindowMs: num(process.env.AUTH_LOCKOUT_WINDOW_MS, 15 * 60 * 1000),
    lockoutDurationMs: num(process.env.AUTH_LOCKOUT_DURATION_MS, 15 * 60 * 1000),
  },

  sentry: {
    dsn: str(process.env.SENTRY_DSN, null),
    tracesSampleRate: num(process.env.SENTRY_TRACES_SAMPLE_RATE, 0.2),
  },

  resend: {
    apiKey: str(process.env.RESEND_API_KEY, null),
    from: str(process.env.RESEND_FROM, 'TopFlowNG <noreply@mail.topflowng.com>'),
    url: str(process.env.RESEND_URL, 'https://api.resend.com/emails'),
    timeoutMs: num(process.env.RESEND_TIMEOUT_MS, 15_000),
  },

  paystack: {
    secretKey: str(process.env.PAYSTACK_SECRET_KEY, null),
    webhookSecret: str(process.env.PAYSTACK_WEBHOOK_SECRET, null),
    apiBaseUrl: str(process.env.PAYSTACK_API_BASE_URL, 'https://api.paystack.co'),
    timeoutMs: num(process.env.PAYSTACK_TIMEOUT_MS, 30_000),
  },

  // Secure, read-only AI assistant (OpenRouter). Model IDs come from the
  // environment, never hardcoded below the defaults; the allow-list is derived
  // from these variables so operators control which models are reachable.
  ai: {
    openRouterApiKey: str(process.env.OPENROUTER_API_KEY, null),
    baseUrl: str(process.env.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1'),
    primaryModel: str(process.env.OPENROUTER_PRIMARY_MODEL, 'deepseek/deepseek-v4-flash'),
    fallbackModel: str(process.env.OPENROUTER_FALLBACK_MODEL, 'hermes'),
    appUrl: str(process.env.OPENROUTER_APP_URL, str(process.env.APP_URL, 'https://topflowng.com')),
    appName: str(process.env.OPENROUTER_APP_NAME, 'TopFlowNG'),
    timeoutMs: num(process.env.AI_TIMEOUT_MS, 30_000),
    maxInputLength: num(process.env.AI_MAX_INPUT_LENGTH, 2_000),
    maxOutputTokens: num(process.env.AI_MAX_OUTPUT_TOKENS, 1_024),
    requestLimitWindowMs: num(process.env.AI_RATE_WINDOW_MS, 60 * 60 * 1000),
    requestLimitMax: num(process.env.AI_RATE_MAX, 20),
    dailyRequestCeiling: num(process.env.AI_DAILY_REQUEST_CEILING, 1_000),
    dailyCostCeiling: num(process.env.AI_DAILY_COST_CEILING, 0),
    modelAllowlist: String(process.env.AI_MODEL_ALLOWLIST || '')
      .split(',')
      .map((m) => m.trim())
      .filter(Boolean),
  },

  clubkonnect: {
    userId: str(process.env.CLUBKONNECT_USER_ID, null),
    apiKey: str(process.env.CLUBKONNECT_API_KEY, null),
    baseUrl: str(process.env.CLUBKONNECT_BASE_URL, 'https://www.clubkonnect.com'),
    queryUrl: str(process.env.CLUBKONNECT_QUERY_URL, 'https://www.nellobytesystems.com/APIQuery.asp'),
    airtimeUrl: str(process.env.CLUBKONNECT_AIRTIME_URL, 'https://www.nellobytesystems.com/APIAirtimeV1.asp'),
    dataUrl: str(process.env.CLUBKONNECT_DATA_URL, 'https://www.nellobytesystems.com/APIDataBundleV1.asp'),
    cableUrl: str(process.env.CLUBKONNECT_CABLE_URL, 'https://www.nellobytesystems.com/APICableTVV1.asp'),
    electricityUrl: str(process.env.CLUBKONNECT_ELECTRICITY_URL, 'https://www.nellobytesystems.com/APIElectricityV1.asp'),
    examUrl: str(process.env.CLUBKONNECT_EXAM_URL, 'https://www.nellobytesystems.com/APIExamPins.asp'),
    rechargeUrl: str(process.env.CLUBKONNECT_RECHARGE_URL, 'https://www.nellobytesystems.com/APIRechargeCard.asp'),
    timeoutMs: num(process.env.CLUBKONNECT_TIMEOUT_MS, 30_000),
    maxPurchaseAmount: num(process.env.MAX_PURCHASE_AMOUNT, 1_000_000),
  },
};

// ── Production startup validation ───────────────────────────────────────────
// In production the app fails fast (at startup, before any listener binds) if a
// variable required to operate the platform is missing. Secrets are never
// logged or echoed — only the variable NAMES are reported. Development/test
// keep their safe fallbacks so local work and automated checks still boot.
//
// DECISION: Paystack (wallet top-up) and Clubkonnect (VTU) are MANDATORY for
// every production deployment — they are the platform's only money-moving
// integration and there is no supported payments/VTU-disabled mode. They stay
// in the hard-required set, so a deployment that omits them refuses to boot
// rather than silently running with broken payments. There is deliberately no
// opt-out flag: an intentionally-paused payments deployment is expressed by not
// routing traffic to this service, never by booting it without the keys.
// Authenticity (not just presence) is verified by the providers at first live
// call; boot-time validation only guarantees a value was provided.
const REQUIRED_PRODUCTION = [
  'DATABASE_URL',        // Postgres connection
  'JWT_SECRET',          // token signing
  'APP_URL',             // canonical origin (CORS, callbacks, reset links)
  'PAYSTACK_SECRET_KEY', // payments — mandatory (see decision note)
  'CLUBKONNECT_USER_ID', // VTU provider — mandatory (see decision note)
  'CLUBKONNECT_API_KEY', // VTU provider — mandatory (see decision note)
];

const OPTIONAL_PRODUCTION = [
  'PAYSTACK_WEBHOOK_SECRET', // falls back to PAYSTACK_SECRET_KEY when absent
  'RESEND_API_KEY',          // email delivery; without it reset/purchase emails fail
  'OPENROUTER_API_KEY',      // AI assistant (read-only, advisory) — degraded when absent
  'SENTRY_DSN',              // observability — disabled when absent
];

function validateProductionConfig() {
  if (!isProduction) return;
  const missing = REQUIRED_PRODUCTION.filter((name) => !process.env[name] || !process.env[name].trim());
  if (missing.length > 0) {
    throw new Error(`[config] Missing required environment variable(s): ${missing.join(', ')}`);
  }
  const optionalMissing = OPTIONAL_PRODUCTION.filter((name) => !process.env[name]);
  if (optionalMissing.length > 0) {
    console.warn(`[config] Optional env var(s) not set (feature degraded): ${optionalMissing.join(', ')}`);
  }
}

validateProductionConfig();

module.exports = config;
