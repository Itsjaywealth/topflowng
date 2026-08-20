/**
 * TopFlowNG — Monnify (TeamApt) payment adapter.
 *
 * Implements the canonical PaymentProvider interface for Monnify. This
 * isolates all Monnify-specific API interaction (auth, transaction init,
 * verification, webhook signature, status, refund) behind the provider
 * abstraction in `payment/index.js`. No secret ever leaves this module;
 * naira is returned to callers and kobo is only used internally where the
 * Monnify API requires it.
 *
 * The adapter is selected when `PAYMENT_PROVIDER=monnify` and `MONNIFY_ENABLED
 * =true` with valid credentials. Until then the factory in `payment/index.js`
 * refuses to return this adapter (PAYMENT_PROVIDER_DISABLED).
 *
 * Flow used here: the checkout transaction (`POST /api/v2/transactions`)
 * returns a hosted checkout URL that supports BOTH card and bank transfer
 * (virtual account) payment methods, so the same integration covers web and
 * mobile without any per-client UI. The wallet is credited authoritatively
 * from the Monnify webhook / transaction verification — never from a client
 * claim.
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');

const config = require('../config');
const logger = require('../lib/logger');
const { PaymentError } = require('./index');

const NAME = 'monnify';

let cachedToken = null;
let tokenExpiresAt = 0;

function credentials() {
  if (!config.monnify.enabled) {
    throw new PaymentError('Monnify is not enabled (BLOCKED_EXTERNAL)', 'PAYMENT_PROVIDER_DISABLED');
  }
  if (!config.monnify.apiKey || !config.monnify.secretKey || !config.monnify.contractCode) {
    throw new PaymentError('Monnify is missing credentials (API key, secret key, contract code)', 'PAYMENT_PROVIDER_DISABLED');
  }
  return config.monnify;
}

function assertReady() {
  credentials();
}

/**
 * Obtain and cache a Monnify bearer token.
 * Uses HTTP Basic auth with `apiKey:secretKey` per Monnify's documented auth.
 * @returns {Promise<string>} access token
 */
async function getAccessToken() {
  const cfg = credentials();
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt) return cachedToken;

  const basic = Buffer.from(`${cfg.apiKey}:${cfg.secretKey}`).toString('base64');
  let response;
  try {
    response = await axios.post(
      `${cfg.baseUrl}/api/v1/auth/login`,
      null,
      {
        headers: { Authorization: `Basic ${basic}` },
        timeout: config.paystack.timeoutMs || 30_000,
      }
    );
  } catch (err) {
    const detail = err.response?.data?.responseMessage || err.response?.status || err.message;
    logger.error('Monnify auth failed', { detail });
    throw new PaymentError('Unable to authenticate with the payment provider.', 'PAYMENT_UPSTREAM_ERROR');
  }

  const body = response.data || {};
  const token = body.responseBody && body.responseBody.accessToken;
  const expiresIn = body.responseBody && body.responseBody.expiresIn;
  if (!token) {
    throw new PaymentError('Payment provider returned no access token.', 'PAYMENT_UPSTREAM_ERROR');
  }
  cachedToken = token;
  // Slightly under-commit the expiry so we never race the provider's TTL.
  tokenExpiresAt = now + (Number(expiresIn) || 3600) * 1000 - 30_000;
  return token;
}

async function authHeaders() {
  const token = await getAccessToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Initialize a Monnify checkout.
 * @param {object} args { email, amount (naira), reference, metadata, callbackUrl }
 * @returns {Promise<{authorizationUrl, reference}>}
 *   authorizationUrl is the hosted Monnify checkout (card + transfer).
 */
async function initializePayment({ email, amount, reference, metadata = {}, callbackUrl } = {}) {
  assertReady();
  const cfg = credentials();
  const amountKobo = Math.round(parseFloat(amount) * 100);

  const payload = {
    amount: amountKobo,
    customerName: metadata.user_name || metadata.customer_name || (email || '').split('@')[0] || 'Customer',
    customerEmail: email,
    paymentReference: reference,
    paymentDescription: metadata.payment_description || 'Wallet funding',
    currencyCode: 'NGN',
    contractCode: cfg.contractCode,
    redirectUrl: callbackUrl || `${config.appUrl}/?verified=${reference}`,
    paymentMethods: ['CARD', 'ACCOUNT_TRANSFER'],
    metadata: { ...metadata, user_id: metadata.user_id != null ? String(metadata.user_id) : undefined },
  };

  let response;
  try {
    response = await axios.post(
      `${cfg.baseUrl}/api/v2/transactions`,
      payload,
      {
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        timeout: config.paystack.timeoutMs || 30_000,
      }
    );
  } catch (err) {
    const detail = err.response?.data?.responseMessage || err.response?.status || err.message;
    logger.error('Monnify transaction init failed', { detail });
    throw new PaymentError('Unable to start a payment session with the provider.', 'PAYMENT_UPSTREAM_ERROR');
  }

  const body = response.data || {};
  const data = body.responseBody || {};
  const checkoutUrl = data.checkoutUrl;
  if (!checkoutUrl) {
    throw new PaymentError('Payment provider returned no checkout URL.', 'PAYMENT_UPSTREAM_ERROR');
  }
  return {
    authorizationUrl: checkoutUrl,
    reference: data.paymentReference || reference,
  };
}

/**
 * Verify a Monnify transaction by payment reference.
 * @returns {Promise<{reference, status, amount, currency, metadata, userId}>}
 *   status 'success' only when authoritatively confirmed paid by Monnify.
 */
async function verifyPayment(reference) {
  assertReady();
  const cfg = credentials();
  let response;
  try {
    response = await axios.get(
      `${cfg.baseUrl}/api/v2/transactions/${encodeURIComponent(reference)}`,
      {
        headers: await authHeaders(),
        timeout: config.paystack.timeoutMs || 30_000,
      }
    );
  } catch (err) {
    const detail = err.response?.data?.responseMessage || err.response?.status || err.message;
    logger.error('Monnify verify failed', { reference, detail });
    throw new PaymentError('Unable to verify the payment with the provider.', 'PAYMENT_UPSTREAM_ERROR');
  }

  const body = response.data || {};
  const data = body.responseBody || {};
  const status = (data.transactionStatus || data.paymentStatus || '').toLowerCase();
  if (status !== 'successful' && status !== 'paid') {
    throw new PaymentError('Payment is not a verified successful charge', 'PAYMENT_NOT_SUCCESSFUL');
  }
  if (data.paymentReference && data.paymentReference !== reference) {
    throw new PaymentError('Payment provider returned a mismatched reference', 'PAYMENT_NOT_SUCCESSFUL');
  }

  const meta = data.metadata || {};
  const userId = meta.user_id != null ? Number(meta.user_id) : null;
  if (!userId) {
    throw new PaymentError(`Verified Monnify payment ${reference} has no user_id metadata`, 'PAYMENT_USER_MISSING');
  }

  return {
    reference: data.paymentReference || reference,
    status: 'success',
    amount: Number(data.amountPaid || data.amount || 0) / 100,
    currency: data.currencyCode || 'NGN',
    metadata: meta,
    userId,
  };
}

/**
 * Constant-time HMAC-SHA512 signature check for the Monnify webhook.
 * Monnify signs the raw request body with the secret key and sends it in the
 * `monnify-signature` header as a hex digest. Malformed/missing signatures
 * short-circuit to false before timingSafeEqual (which throws on length mismatch).
 */
function verifyWebhookSignature({ rawBody, signature } = {}) {
  const cfg = credentials();
  const HEX = /^[0-9a-fA-F]+$/;
  if (typeof signature !== 'string' || !HEX.test(signature)) return false;
  const hash = crypto.createHmac('sha512', cfg.secretKey).update(rawBody).digest('hex');
  const expected = Buffer.from(hash, 'hex');
  const presented = Buffer.from(signature, 'hex');
  return expected.length === presented.length && crypto.timingSafeEqual(expected, presented);
}

/**
 * Read the event type + payment reference from a parsed Monnify webhook body.
 * Monnify sends `eventType` (e.g. SUCCESSFUL_TRANSACTION) and `eventData`
 * containing `paymentReference`/`transactionReference`/`amountPaid`.
 */
function webhookEvent(body) {
  const data = body?.eventData || {};
  return {
    event: body?.eventType || body?.event || '',
    reference: data.paymentReference || data.transactionReference || null,
    amountPaid: Number(data.amountPaid || 0) / 100,
  };
}

/**
 * Return the current status of a Monnify transaction (lighter than verify).
 */
async function getPaymentStatus(reference) {
  assertReady();
  const cfg = credentials();
  try {
    const response = await axios.get(
      `${cfg.baseUrl}/api/v2/transactions/${encodeURIComponent(reference)}`,
      {
        headers: await authHeaders(),
        timeout: config.paystack.timeoutMs || 30_000,
      }
    );
    const data = response.data?.responseBody || {};
    const status = (data.transactionStatus || data.paymentStatus || '').toLowerCase();
    return {
      reference: data.paymentReference || reference,
      status: status === 'successful' || status === 'paid' ? 'success'
        : status === 'failed' || status === 'cancelled' ? 'failed' : 'pending',
      amount: Number(data.amountPaid || data.amount || 0) / 100,
    };
  } catch (err) {
    logger.error('Monnify status check failed', { reference, message: err.message });
    throw new PaymentError('Unable to check payment status with the provider.', 'PAYMENT_UPSTREAM_ERROR');
  }
}

/**
 * Refund a Monnify transaction (idempotent). Only invoked where a safe refund
 * path is authorised — never triggered by a timeout/unknown fulfilment.
 */
async function refundPayment({ reference, amount, reason } = {}) {
  assertReady();
  const cfg = credentials();
  let response;
  try {
    response = await axios.post(
      `${cfg.baseUrl}/api/v2/disbursements/refund-transaction`,
      {
        transactionReference: reference,
        refundReference: `TF-REFUND-${Date.now()}`,
        amount: Math.round(parseFloat(amount) * 100),
        reason: reason || 'TopFlowNG refund',
        currencyCode: 'NGN',
      },
      {
        headers: { ...(await authHeaders()), 'Content-Type': 'application/json' },
        timeout: config.paystack.timeoutMs || 30_000,
      }
    );
  } catch (err) {
    const detail = err.response?.data?.responseMessage || err.response?.status || err.message;
    logger.error('Monnify refund failed', { reference, detail });
    throw new PaymentError('Unable to process the refund with the provider.', 'PAYMENT_UPSTREAM_ERROR');
  }
  const ok = response.data?.requestSuccessful === true;
  logger.info('Monnify refund issued', { reference, status: ok ? 'success' : 'submitted' });
  return { reference, status: ok ? 'processing' : 'submitted' };
}

module.exports = {
  NAME,
  initializePayment,
  verifyPayment,
  verifyWebhookSignature,
  webhookEvent,
  getPaymentStatus,
  refundPayment,
};