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

const crypto = require('crypto');

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
  internalApiKey: str(process.env.INTERNAL_API_KEY, ''),
  ownerEmails: (process.env.OWNER_EMAILS || 'josephegbedi@gmail.com,admin@brandverseventures.com')
    .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
  trustProxy: str(process.env.TRUST_PROXY, '1') === '1',
  bodyLimit: str(process.env.BODY_LIMIT, '10kb'),

  jwt: {
    secret: requireSecret('JWT_SECRET') || 'dev-insecure-jwt-secret-change-me',
    expiresIn: str(process.env.JWT_EXPIRES_IN, '7d'),
  },

  // Outbound automation event bus (n8n webhooks, BizFlowNG sync).
  events: {
    timeoutMs: num(process.env.EVENT_TIMEOUT_MS, 10000),
    deliverySweepMs: num(process.env.EVENT_DELIVERY_SWEEP_MS, 60 * 1000),
    dormantDays: num(process.env.DORMANT_DAYS, 30),
    dormantBatchLimit: num(process.env.DORMANT_BATCH_LIMIT, 100),
    renewalWindowDays: num(process.env.RENEWAL_WINDOW_DAYS, 3),
  },

  // BizFlowNG cross-app integration (expense sync). The API key each customer
  // links is encrypted at rest with a key derived from ENCRYPTION_KEY.
  bizflow: {
    apiUrl: str(process.env.BIZFLOWNG_API_URL, ''),
    verifyPath: str(process.env.BIZFLOWNG_VERIFY_PATH, '/api/integrations/topflowng/link/verify'),
    syncPath: str(process.env.BIZFLOWNG_SYNC_PATH, '/api/integrations/topflowng/expenses'),
    encryptionKey: (() => {
      const raw = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET || '';
      return crypto.createHash('sha256').update(`topflowng:bizflow-link:${raw}`).digest();
    })(),
  },

  // Approved TopFlowNG categories that may sync into BizFlowNG as expenses.
  bizflowSyncCategories: ['electricity', 'airtime', 'data', 'cable', 'exam-pin', 'other'],


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
    // TOTP at-rest encryption (falls back to a derivation of the JWT secret).
    totpEncryptionKey: str(process.env.TOTP_ENCRYPTION_KEY, null),
    // 2FA is OPT-IN for everyone (owners included). When enabled per-account,
    // login demands a TOTP code. Flip OWNER_2FA_REQUIRED=true to force
    // enrolment for owner emails.
    ownerTwoFactorRequired: str(process.env.OWNER_2FA_REQUIRED, 'false') === 'true',
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
    // Empty default: SMTP is an OPTIONAL transport. When unconfigured, email
    // goes straight to the Resend/Brevo API path — no doomed SMTP attempts.
    host: str(process.env.SMTP_HOST, ''),
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

  // ── Push notifications (Web Push / VAPID) ────────────────────────────────────
  push: {
    vapidPublicKey: str(process.env.VAPID_PUBLIC_KEY, null),
    vapidPrivateKey: str(process.env.VAPID_PRIVATE_KEY, null),
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

  // Secure, read-only AI assistant (OpenRouter + OpenAI). Model IDs come from
  // the environment, never hardcoded below the defaults; the allow-list is
  // derived from these variables so operators control which models are
  // reachable. providerOrder controls failover (e.g. "openai,openrouter").
  ai: {
    openRouterApiKey: str(process.env.OPENROUTER_API_KEY, null),
    baseUrl: str(process.env.OPENROUTER_BASE_URL, 'https://openrouter.ai/api/v1'),
    primaryModel: str(process.env.OPENROUTER_PRIMARY_MODEL, 'deepseek/deepseek-v4-flash'),
    fallbackModel: str(process.env.OPENROUTER_FALLBACK_MODEL, 'hermes'),
    openAiApiKey: str(process.env.OPENAI_API_KEY, null),
    openAiBaseUrl: str(process.env.OPENAI_BASE_URL, 'https://api.openai.com/v1'),
    openAiPrimaryModel: str(process.env.OPENAI_PRIMARY_MODEL, 'gpt-4o-mini'),
    openAiFallbackModel: str(process.env.OPENAI_FALLBACK_MODEL, 'gpt-4o-mini'),
    providerOrder: str(process.env.AI_PROVIDER_ORDER, 'openrouter'),
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
    // The sweeper keeps auto-reconciling traceable pending orders up to this many
    // attempts. At a 2-min backoff, 720 attempts covers a full 24h before the
    // order is handed off to expireLongPendingVtuOrders for a final resolution.
    // Orders are never debited while pending, so an eventually-failed outcome is
    // always safe and honest.
    reconcileMaxAttempts: num(process.env.PENDING_ORDER_RECONCILE_MAX_ATTEMPTS, 720),
    reconcilePollCooldownMs: num(process.env.PENDING_ORDER_RECONCILE_POLL_COOLDOWN_MS, 10_000),
    // Provider wallet watchdog — alert when the VTPass float drops below this
    // (0 disables). Checks run every VTPASS_BALANCE_CHECK_MINUTES.
    minBalanceAlertNgn: num(process.env.VTPASS_MIN_BALANCE_ALERT_NGN, 5_000),
    balanceCheckMinutes: num(process.env.VTPASS_BALANCE_CHECK_MINUTES, 15),
    // Catalogue reconciliation against live service-variations (minutes).
    catalogSyncMinutes: num(process.env.VTPASS_CATALOG_SYNC_MINUTES, 360),
  },

// ── Markup / service fees ───────────────────────────────────────────────────
  // The platform charges a percentage markup on airtime and a flat service fee
  // on electricity to cover provider costs and operating margin. These rates are
  // applied server-side — customers see the total (service amount + markup) as
  // their final debit amount.
  markup: {
    // Airtime: percentage markup applied to every purchase (e.g. 0.02 = 2%).
    // The minimum markup is ₦2 so very small purchases still contribute.
    airtimeRate: num(process.env.AIRTIME_MARKUP_RATE, 0.02),
    airtimeMinMarkup: num(process.env.AIRTIME_MIN_MARKUP, 2),
    // Electricity: flat naira fee added to every electricity token purchase.
    electricityFee: num(process.env.ELECTRICITY_SERVICE_FEE, 100),
  },

  // ── Promotions / discounts ───────────────────────────────────────────────────
  // Percentage discounts applied at purchase time. All default to 0 (no discount).
  // Weekend happy hour applies an additional discount on Saturday and Sunday.
  discounts: {
    airtimePercent: num(process.env.DISCOUNT_AIRTIME_PERCENT, 0),
    dataPercent: num(process.env.DISCOUNT_DATA_PERCENT, 0),
    cablePercent: num(process.env.DISCOUNT_CABLE_PERCENT, 0),
    electricityPercent: num(process.env.DISCOUNT_ELECTRICITY_PERCENT, 0),
    examPercent: num(process.env.DISCOUNT_EXAM_PERCENT, 0),
    weekendHappyHourPercent: num(process.env.DISCOUNT_WEEKEND_HAPPY_HOUR_PERCENT, 2),
    weekendHappyHourEnabled: str(process.env.DISCOUNT_WEEKEND_HAPPY_HOUR, 'false') === 'true',
  },

  // ── SMS (Termii) ──────────────────────────────────────────────────────────────
  // Transactional SMS (purchase receipts, wallet credits). Delivery is via
  // Termii's Nigerian gateway. When no API key is configured, SMS is a silent
  // no-op so the platform keeps working with email + in-app notifications only.
  sms: {
    termiiApiKey: str(process.env.TERMII_API_KEY, null),
    senderId: str(process.env.TERMII_SENDER_ID || process.env.SMS_SENDER_ID, 'TopFlowNG'),
    baseUrl: str(process.env.TERMII_BASE_URL, 'https://api.ng.termii.com/api/sms/send'),
    timeoutMs: num(process.env.TERMII_TIMEOUT_MS, 15_000),
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

  // ── Customer payment mode ──────────────────────────────────────────────────
  // 'wallet' = current/legacy model: customer funds a stored wallet balance,
  //            then purchases debit that balance (FUNDING_ENABLED gates top-up).
  // 'direct' = per-order payment: customer pays for each specific order via the
  //            payment provider (Paystack), then VTPass fulfils that order. No
  //            customer stored-value wallet. Wallet funding UI/CTA are hidden.
  //
  // PRODUCTION MUST REMAIN ON 'wallet' UNTIL AN EXPLICIT CUTOVER IS AUTHORIZED.
  // Switching to 'direct' is a production financial change — it removes the
  // customer wallet and changes the purchase/payment pipeline.
  paymentMode: str(process.env.PAYMENT_MODE, 'wallet'),

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
  'OPENAI_API_KEY',          // AI assistant (read-only, advisory) — degraded when absent
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
