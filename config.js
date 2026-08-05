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

module.exports = config;
