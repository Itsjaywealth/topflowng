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
  supportEmail: str(process.env.SUPPORT_EMAIL, 'hello@topflowng.com'),
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
    purchaseWindowMs: num(process.env.PURCHASE_RATE_WINDOW_MS, 60 * 1000),
    purchaseMax: num(process.env.PURCHASE_RATE_MAX, 10),
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

  // Optional SMTP delivery. The hello@topflowng.com mailbox is hosted on Titan
  // Email (MX mx1/mx2.titan.email; SMTP smtp.titan.email). When fully
  // configured, SMTP is preferred for transactional email; the Resend/Brevo
  // path above remains the automatic fallback.
  smtp: {
    host: str(process.env.SMTP_HOST, 'smtp.titan.email'),
    port: num(process.env.SMTP_PORT, 465),
    secure: str(process.env.SMTP_SECURE, '1') === '1',
    user: str(process.env.SMTP_USER, null),
    password: str(process.env.SMTP_PASSWORD, null),
    from: str(process.env.SMTP_FROM, 'TopFlowNG <hello@topflowng.com>'),
    timeoutMs: num(process.env.SMTP_TIMEOUT_MS, 15_000),
  },

  paystack: {
    secretKey: str(process.env.PAYSTACK_SECRET_KEY, null),
    webhookSecret: str(process.env.PAYSTACK_WEBHOOK_SECRET, null),
    apiBaseUrl: str(process.env.PAYSTACK_API_BASE_URL, 'https://api.paystack.co'),
    timeoutMs: num(process.env.PAYSTACK_TIMEOUT_MS, 30_000),
  },

  // ── Payment provider selection ─────────────────────────────────────────────
  // TopFlowNG collects payment through a provider abstraction so it is not
  // permanently coupled to Paystack. `PAYMENT_PROVIDER` selects the active
  // adapter: 'paystack' (the currently configured provider) or 'monnify' (a
  // prepared adapter that stays DISABLED/BLOCKED_EXTERNAL until business
  // approval and credentials are supplied). This is a payment-collection
  // abstraction only — it has NO effect on VTPass fulfilment, which is a
  // separate fulfilment provider. Production stays on 'paystack' until an
  // explicit cutover is authorized.
  paymentProvider: str(process.env.PAYMENT_PROVIDER, 'paystack'),
  monnify: {
    enabled: str(process.env.MONNIFY_ENABLED, 'false') === 'true',
    baseUrl: str(process.env.MONNIFY_BASE_URL, 'https://api.monnify.com'),
    secretKey: str(process.env.MONNIFY_SECRET_KEY, null),
    apiKey: str(process.env.MONNIFY_API_KEY, null),
    contractCode: str(process.env.MONNIFY_CONTRACT_CODE, null),
  },

  // tawk.to live chat. Secure Mode hashes the visitor's email/name on the
  // server (HMAC-SHA256 with the API key) so identifiable data is only ever
  // sent to tawk.to when the key is configured; otherwise the widget loads
  // anonymously. The widget is non-critical: if tawk.to is down or the domain
  // is unreachable, login, wallet, checkout, history and all transaction flows
  // must keep working — the client-side loader treats it as best-effort.
  tawk: {
    propertyId: str(process.env.TAWK_PROPERTY_ID, '6a85673ae687441d49b902c2'),
    widgetId: str(process.env.TAWK_WIDGET_ID, '1k0chmfq6'),
    apiKey: str(process.env.TAWK_API_KEY, null),
    // When true, the loader passes authenticated visitor name/email into the
    // widget only if a hash could be produced server-side. Set false to run
    // fully anonymous.
    secureMode: str(process.env.TAWK_SECURE_MODE, '1') === '1',
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

  // VTPass VTU provider (replaces the legacy Clubkonnect/Nellobyte API, which
  // was unreachable: every endpoint returned MISSING_PHONE_NUMBER).
  //   POST /api/pay      — purchase  (headers: api-key + secret-key)
  //   POST /api/requery  — status    (headers: api-key + secret-key)
  //   GET  /api/service-variations — plan catalog (headers: api-key + public-key)
  vtpass: {
    apiKey: str(process.env.VTPASS_API_KEY, null),
    secretKey: str(process.env.VTPASS_SECRET_KEY, null),
    publicKey: str(process.env.VTPASS_PUBLIC_KEY, null),
    // Basic auth credentials (used when VTPASS_AUTH_TYPE=basic)
    username: str(process.env.VTPASS_USERNAME, null),
    password: str(process.env.VTPASS_PASSWORD, null),
    authType: str(process.env.VTPASS_AUTH_TYPE, 'apikey'), // 'apikey' | 'basic'
    baseUrl: str(process.env.VTPASS_BASE_URL, 'https://vtpass.com/api'),
    timeoutMs: num(process.env.VTPASS_TIMEOUT_MS, 30_000),
    maxPurchaseAmount: num(process.env.MAX_PURCHASE_AMOUNT, 1_000_000),
    // Optional JSON blob overriding the built-in product→service/variation map
    // without a code change. Shape: {"MTN1GB":{"serviceID":"mtn-data","variation":"mtn-sme-1gb"}}
    productMapJson: str(process.env.VTPASS_PRODUCT_MAP, null),
    pendingOrderExpiryMinutes: num(process.env.PENDING_ORDER_EXPIRY_MINUTES, 6),
    sweepIntervalMs: num(process.env.PENDING_ORDER_SWEEP_INTERVAL_MS, 30_000),
    reconcileBackoffMinutes: num(process.env.PENDING_ORDER_RECONCILE_BACKOFF_MINUTES, 2),
    reconcileMaxAttempts: num(process.env.PENDING_ORDER_RECONCILE_MAX_ATTEMPTS, 30),
    reconcilePollCooldownMs: num(process.env.PENDING_ORDER_RECONCILE_POLL_COOLDOWN_MS, 10_000),
  },

  // ── Provider capability registry & feature flags ──────────────────────────
  // Server-controlled model for multi-provider readiness. Each provider is
  // described by its status and the capabilities it offers. Unfinished
  // providers (Bitrefill/DT One) are NOT_CONFIGURED and their customer-facing
  // categories are locked OFF by default. Nothing here enables a purchase or
  // exposes a product — these are architectural readiness flags only.
  providers: {
    vtpass: {
      name: 'VTPass',
      status: 'INTEGRATED', // INTEGRATED | NOT_CONFIGURED | BLOCKED_EXTERNAL
      capabilities: ['AIRTIME_NG', 'DATA_NG', 'ELECTRICITY_NG', 'CABLE_NG', 'EDUCATION_NG'],
    },
    bitrefill: {
      name: 'Bitrefill',
      status: str(process.env.BITREFILL_STATUS, 'BLOCKED_EXTERNAL'), // awaiting approval/credentials
      capabilities: ['GIFT_CARDS', 'ESIMS', 'INTERNATIONAL_REFILLS'],
    },
    dtone: {
      name: 'DT One',
      status: str(process.env.DTONE_STATUS, 'BLOCKED_EXTERNAL'), // awaiting onboarding/credentials
      capabilities: ['INTERNATIONAL_AIRTIME', 'INTERNATIONAL_DATA', 'ESIMS', 'GIFT_CARDS', 'DIGITAL_VOUCHERS'],
    },
  },

  // Customer-facing category flags — ALL OFF until a provider is legitimately
  // approved, credentialed, sandbox-certified and production-certified.
  features: {
    giftCards: str(process.env.GIFT_CARDS_ENABLED, 'false') === 'true',
    esims: str(process.env.ESIMS_ENABLED, 'false') === 'true',
    internationalAirtime: str(process.env.INTERNATIONAL_AIRTIME_ENABLED, 'false') === 'true',
    internationalData: str(process.env.INTERNATIONAL_DATA_ENABLED, 'false') === 'true',
    digitalVouchers: str(process.env.DIGITAL_VOUCHERS_ENABLED, 'false') === 'true',
  },

  // Global / category purchase safety switches (server-controlled, admin-only
  // intent). All default to allowing purchases. A kill switch here does NOT
  // auto-fund, refund, or retry — it only gates new purchase initiation.
  safety: {
    purchasesEnabled: str(process.env.PURCHASES_ENABLED, 'true') === 'true',
    fundingEnabled: str(process.env.FUNDING_ENABLED, 'true') === 'true',
  },

  // Build/version metadata — non-secret operator visibility into which Git
  // commit is running. Railway injects RAILWAY_GIT_COMMIT_SHA by default;
  // APP_COMMIT / GIT_SHA are accepted as alternatives. Falls back to a
  // harmless unknown marker so local/test boots stay clean. Never secrets.
  build: {
    commit: str(
      process.env.RAILWAY_GIT_COMMIT_SHA || process.env.APP_COMMIT || process.env.GIT_SHA,
      'unknown'
    ),
    version: str(process.env.APP_VERSION, require('./package.json').version),
    node: process.version,
  },
};

// ── Production startup validation ───────────────────────────────────────────
// In production the app fails fast (at startup, before any listener binds) if a
// variable required to operate the platform is missing. Secrets are never
// logged or echoed — only the variable NAMES are reported. Development/test
// keep their safe fallbacks so local work and automated checks still boot.
//
// DECISION: Paystack (wallet top-up) and VTPass (VTU) are MANDATORY for every
// production deployment — they are the platform's only money-moving integration
// and there is no supported payments/VTU-disabled mode. They stay in the
// hard-required set, so a deployment that omits them refuses to boot rather
// than silently running with broken payments. There is deliberately no opt-out
// flag: an intentionally-paused payments deployment is expressed by not routing
// traffic to this service, never by booting it without the keys. Authenticity
// (not just presence) is verified by the providers at first live call;
// boot-time validation only guarantees a value was provided.
const REQUIRED_PRODUCTION = [
  'DATABASE_URL',        // Postgres connection
  'JWT_SECRET',          // token signing
  'APP_URL',             // canonical origin (CORS, callbacks, reset links)
  'PAYSTACK_SECRET_KEY', // payments — mandatory (see decision note)
  // VTPass keys are validated below based on VTPASS_AUTH_TYPE
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

  // VTPass auth validation: require credentials matching the configured auth type
  const vtpassAuthType = str(process.env.VTPASS_AUTH_TYPE, 'apikey');
  if (vtpassAuthType === 'basic') {
    const missingBasic = ['VTPASS_USERNAME', 'VTPASS_PASSWORD'].filter(
      (name) => !process.env[name] || !process.env[name].trim()
    );
    if (missingBasic.length > 0) {
      throw new Error(`[config] VTPass Basic auth requires: ${missingBasic.join(', ')}`);
    }
  } else {
    const missingApiKey = ['VTPASS_API_KEY', 'VTPASS_SECRET_KEY', 'VTPASS_PUBLIC_KEY'].filter(
      (name) => !process.env[name] || !process.env[name].trim()
    );
    if (missingApiKey.length > 0) {
      throw new Error(`[config] VTPass API key auth requires: ${missingApiKey.join(', ')}`);
    }
  }

  const optionalMissing = OPTIONAL_PRODUCTION.filter((name) => !process.env[name]);
  if (optionalMissing.length > 0) {
    console.warn(`[config] Optional env var(s) not set (feature degraded): ${optionalMissing.join(', ')}`);
  }
}

validateProductionConfig();

module.exports = config;
