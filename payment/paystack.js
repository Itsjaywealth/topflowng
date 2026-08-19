/**
 * TopFlowNG — Paystack payment adapter.
 *
 * Implements the canonical PaymentProvider interface for Paystack. This
 * isolates all Paystack-specific API interaction (initialization, verification,
 * webhook signature, refund) behind the provider abstraction in `payment/index.js`.
 * No secret ever leaves this module; minor units (kobo) are used internally and
 * naira is returned to callers.
 */

'use strict';

const crypto = require('crypto');
const axios = require('axios');

const config = require('../config');
const logger = require('../lib/logger');
const { PaymentError } = require('./index');

const NAME = 'paystack';
const KOBO_PER_NAIRA = 100;

/**
 * Initialize a Paystack checkout.
 * @param {object} args { email, amount (naira), reference, metadata, callbackUrl }
 * @returns {Promise<{authorizationUrl, reference}>}
 */
async function initializePayment({ email, amount, reference, metadata = {}, callbackUrl } = {}) {
  if (!config.paystack.secretKey) {
    throw new PaymentError('Paystack secret key is not configured', 'PAYMENT_PROVIDER_NOT_CONFIGURED');
  }
  const amountKobo = Math.round(parseFloat(amount) * KOBO_PER_NAIRA);
  const response = await axios.post(`${config.paystack.apiBaseUrl}/transaction/initialize`, {
    email,
    amount: amountKobo,
    reference,
    callback_url: callbackUrl || `${config.appUrl}/?verified=${reference}`,
    metadata,
  }, {
    headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
    timeout: config.paystack.timeoutMs,
  });
  return {
    authorizationUrl: response.data.data.authorization_url,
    reference,
  };
}

/**
 * Verify a Paystack transaction.
 * @returns {Promise<{reference, status, amount, currency, metadata, userId}>}
 *   status 'success' only when authoritatively verified.
 */
async function verifyPayment(reference) {
  const response = await axios.get(`${config.paystack.apiBaseUrl}/transaction/verify/${reference}`, {
    headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
    timeout: config.paystack.timeoutMs,
  });
  const payment = response.data.data;
  if (payment.status !== 'success' || payment.reference !== reference) {
    throw new PaymentError('Paystack payment is not a verified successful charge', 'PAYMENT_NOT_SUCCESSFUL');
  }
  const userId = payment.metadata?.user_id;
  if (!userId) {
    throw new PaymentError(`Verified Paystack payment ${reference} has no user_id metadata`, 'PAYMENT_USER_MISSING');
  }
  return {
    reference: payment.reference,
    status: 'success',
    amount: payment.amount / KOBO_PER_NAIRA,
    currency: payment.currency || 'NGN',
    metadata: payment.metadata || {},
    userId: Number(userId),
  };
}

/**
 * Constant-time HMAC-SHA512 signature check for the Paystack webhook.
 * The expected digest is a 64-byte hex string (128 hex chars). Missing,
 * malformed, or wrong-length signatures short-circuit to false without ever
 * reaching timingSafeEqual (which would throw on unequal buffer lengths).
 */
function verifyWebhookSignature({ rawBody, signature } = {}) {
  const secret = config.paystack.webhookSecret || config.paystack.secretKey;
  const CH = /^[0-9a-fA-F]{128}$/;
  if (typeof signature !== 'string' || !CH.test(signature)) return false;
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  const expected = Buffer.from(hash, 'hex');
  const presented = Buffer.from(signature, 'hex');
  return crypto.timingSafeEqual(expected, presented);
}

/**
 * Read the event name + reference from a parsed Paystack webhook payload.
 */
function webhookEvent(body) {
  const reference = body?.data?.reference;
  const event = body?.event;
  return { event, reference };
}

/**
 * Refund a Paystack transaction. Only invoked where a safe, idempotent refund
 * path is authorised — never triggered by a timeout/unknown fulfilment.
 */
async function refundPayment({ reference, amount, reason } = {}) {
  const response = await axios.post(`${config.paystack.apiBaseUrl}/transaction/refund`, {
    transaction: reference,
    ...(amount ? { amount: Math.round(parseFloat(amount) * KOBO_PER_NAIRA) } : {}),
    ...(reason ? { reason } : {}),
  }, {
    headers: { Authorization: `Bearer ${config.paystack.secretKey}` },
    timeout: config.paystack.timeoutMs,
  });
  logger.info('Paystack refund issued', { reference, status: response.data?.status });
  return { reference, status: response.data?.status === 'success' ? 'processing' : 'submitted' };
}

module.exports = {
  NAME,
  initializePayment,
  verifyPayment,
  verifyWebhookSignature,
  webhookEvent,
  refundPayment,
};
