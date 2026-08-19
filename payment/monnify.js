/**
 * TopFlowNG — Monnify payment adapter (PREPARATION ONLY / DISABLED).
 *
 * This adapter is intentionally NOT active. Monnify remains BLOCKED_EXTERNAL
 * until: (1) business approval is given to onboard Monnify, and (2) valid
 * credentials (secret key, API key, contract code) are supplied via env.
 *
 * It exists so that after approval, switching `PAYMENT_PROVIDER=monnify`
 * (with `MONNIFY_ENABLED=true`) selects Monnify without rewriting VTPass
 * fulfilment. Until then, every method throws PAYMENT_PROVIDER_DISABLED and
 * the factory in `payment/index.js` refuses to return this adapter.
 *
 * No credentials are invented here; nothing calls the Monnify API in this
 * disabled state.
 */

'use strict';

const config = require('../config');
const { PaymentError } = require('./index');

const NAME = 'monnify';

function assertEnabled() {
  if (!config.monnify.enabled || !config.monnify.secretKey || !config.monnify.apiKey || !config.monnify.contractCode) {
    throw new PaymentError('Monnify is not enabled or is missing credentials (BLOCKED_EXTERNAL)', 'PAYMENT_PROVIDER_DISABLED');
  }
}

async function initializePayment() { assertEnabled(); throw new PaymentError('Monnify adapter not implemented', 'PAYMENT_PROVIDER_DISABLED'); }
async function verifyPayment() { assertEnabled(); throw new PaymentError('Monnify adapter not implemented', 'PAYMENT_PROVIDER_DISABLED'); }
function verifyWebhookSignature() { assertEnabled(); throw new PaymentError('Monnify adapter not implemented', 'PAYMENT_PROVIDER_DISABLED'); }
async function getPaymentStatus() { assertEnabled(); throw new PaymentError('Monnify adapter not implemented', 'PAYMENT_PROVIDER_DISABLED'); }
async function refundPayment() { assertEnabled(); throw new PaymentError('Monnify adapter not implemented', 'PAYMENT_PROVIDER_DISABLED'); }

module.exports = { NAME, initializePayment, verifyPayment, verifyWebhookSignature, getPaymentStatus, refundPayment };
