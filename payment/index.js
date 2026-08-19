/**
 * TopFlowNG — payment provider abstraction.
 *
 * TopFlowNG collects payment through a provider-neutral interface so it is not
 * permanently coupled to a single payment gateway. Each concrete adapter
 * (Paystack, Monnify) implements the same contract. The active adapter is
 * selected by `config.paymentProvider` — production stays on 'paystack' until
 * an explicit cutover is authorized.
 *
 * This is a PAYMENT-collection abstraction ONLY. It is fully independent of
 * VTPass, which is the FULFILMENT provider. A future provider like Bitrefill
 * would be a fulfilment provider, never part of this payment-gateway layer.
 */

'use strict';

const config = require('../config');
const logger = require('../lib/logger');

/**
 * Canonical PaymentProvider interface.
 *
 * initializePayment({ email, amount (naira), reference, metadata, callbackUrl })
 *   → Promise<{ authorizationUrl, reference }>
 *
 * verifyPayment(reference)
 *   → Promise<{ reference, status, amount, currency, metadata }>
 *     status is 'success' only when the payment is authoritatively verified.
 *     Throws PaymentNotSuccessful / PaymentUserMissing / PaymentUserMismatch.
 *
 * verifyWebhookSignature({ rawBody, signature })
 *   → boolean  (constant-time where supported)
 *
 * getPaymentStatus(reference)
 *   → Promise<{ reference, status, amount }>
 *
 * refundPayment({ reference, amount })  // where supported
 *   → Promise<{ reference, status }>  (may throw NotImplemented)
 *
 * Adapters MUST:
 *   - never expose secrets to callers
 *   - use minor units (kobo for NGN) internally, return naira
 *   - throw structured errors with `.code` for known failure classes
 */
class PaymentProvider {
  async initializePayment() { throw new Error('Not implemented'); }
  async verifyPayment() { throw new Error('Not implemented'); }
  verifyWebhookSignature() { throw new Error('Not implemented'); }
  async getPaymentStatus() { throw new Error('Not implemented'); }
  async refundPayment() { throw new Error('Not implemented'); }
}

// Known structured error classes used across adapters.
class PaymentError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PaymentError';
    this.code = code || 'PAYMENT_ERROR';
  }
}

/**
 * Resolve and return the active payment provider adapter.
 * Unknown/disabled providers are never silently accepted.
 */
function getPaymentProvider() {
  const name = String(config.paymentProvider || 'paystack').toLowerCase();
  switch (name) {
    case 'paystack':
      return require('./paystack');
    case 'monnify':
      // Monnify is a prepared adapter that stays DISABLED until business
      // approval AND credentials are supplied. The factory refuses to return
      // it unless fully configured, so it can never be silently selected
      // without working credentials.
      if (!config.monnify.enabled ||
          !config.monnify.secretKey ||
          !config.monnify.apiKey ||
          !config.monnify.contractCode) {
        throw new PaymentError('Monnify is not enabled or is missing credentials (BLOCKED_EXTERNAL)', 'PAYMENT_PROVIDER_DISABLED');
      }
      return require('./monnify');
    default:
      logger.error('Unknown payment provider requested', { provider: name });
      throw new PaymentError(`Unknown payment provider: ${name}`, 'PAYMENT_PROVIDER_UNKNOWN');
  }
}

module.exports = {
  PaymentProvider,
  PaymentError,
  getPaymentProvider,
};
