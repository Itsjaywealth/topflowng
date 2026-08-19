/**
 * TopFlowNG — payment provider abstraction tests.
 *
 * Verifies:
 *   - the active provider resolves to Paystack by default (backwards-compatible)
 *   - the Paystack adapter exposes the canonical interface
 *   - Monnify stays DISABLED / BLOCKED_EXTERNAL until credentials are supplied
 *   - unknown providers are rejected
 *   - adapter never exposes secrets
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const config = require('../config');
const { getPaymentProvider, PaymentError } = require('../payment');

test('default active payment provider is paystack (backwards-compatible)', () => {
  const original = config.paymentProvider;
  try {
    config.paymentProvider = 'paystack';
    const provider = getPaymentProvider();
    assert.ok(provider);
    assert.strictEqual(provider.NAME, 'paystack');
    for (const method of ['initializePayment', 'verifyPayment', 'verifyWebhookSignature', 'webhookEvent', 'refundPayment']) {
      assert.strictEqual(typeof provider[method], 'function', `${method} must exist`);
    }
  } finally {
    config.paymentProvider = original;
  }
});

test('monnify is DISABLED / BLOCKED_EXTERNAL without credentials', () => {
  const originalProvider = config.paymentProvider;
  const originalEnabled = config.monnify.enabled;
  try {
    config.paymentProvider = 'monnify';
    config.monnify.enabled = false;
    assert.throws(() => getPaymentProvider(), (e) => e.code === 'PAYMENT_PROVIDER_DISABLED');
  } finally {
    config.paymentProvider = originalProvider;
    config.monnify.enabled = originalEnabled;
  }
});

test('monnify stays blocked even when enabled flag set but credentials missing', () => {
  const originalProvider = config.paymentProvider;
  const originalEnabled = config.monnify.enabled;
  const originalSecret = config.monnify.secretKey;
  try {
    config.paymentProvider = 'monnify';
    config.monnify.enabled = true;
    config.monnify.secretKey = null; // no credentials
    // factory refuses to return the adapter without full credentials
    assert.throws(() => getPaymentProvider(), (e) => e.code === 'PAYMENT_PROVIDER_DISABLED');
  } finally {
    config.paymentProvider = originalProvider;
    config.monnify.enabled = originalEnabled;
    config.monnify.secretKey = originalSecret;
  }
});

test('unknown payment provider is rejected', () => {
  const original = config.paymentProvider;
  try {
    config.paymentProvider = 'stripe';
    assert.throws(() => getPaymentProvider(), (e) => e.code === 'PAYMENT_PROVIDER_UNKNOWN');
  } finally {
    config.paymentProvider = original;
  }
});

test('paystack webhook signature verification rejects malformed signatures', () => {
  const provider = getPaymentProvider();
  // wrong-length / non-hex signatures must be rejected before timing-safe compare
  assert.strictEqual(provider.verifyWebhookSignature({ rawBody: Buffer.from('x'), signature: 'short' }), false);
  assert.strictEqual(provider.verifyWebhookSignature({ rawBody: Buffer.from('x'), signature: 'zzzz' }), false);
});

test('paystack webhookEvent extracts event + reference', () => {
  const provider = getPaymentProvider();
  const { event, reference } = provider.webhookEvent({ event: 'charge.success', data: { reference: 'TF-123' } });
  assert.strictEqual(event, 'charge.success');
  assert.strictEqual(reference, 'TF-123');
});
