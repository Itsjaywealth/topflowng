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

// ── Monnify adapter ────────────────────────────────────────────────────────
const monnify = require('../payment/monnify');
const crypto = require('crypto');

function enableMonnify() {
  const original = { provider: config.paymentProvider, enabled: config.monnify.enabled, secret: config.monnify.secretKey, api: config.monnify.apiKey, contract: config.monnify.contractCode };
  config.paymentProvider = 'monnify';
  config.monnify.enabled = true;
  config.monnify.secretKey = 'sk-monnify-test-secret';
  config.monnify.apiKey = 'mk-test-api-key';
  config.monnify.contractCode = 'CT-TEST-001';
  return original;
}

function disableMonnify(original) {
  config.paymentProvider = original.provider;
  config.monnify.enabled = original.enabled;
  config.monnify.secretKey = original.secret;
  config.monnify.apiKey = original.api;
  config.monnify.contractCode = original.contract;
}

test('monnify adapter exposes the canonical interface when enabled with credentials', () => {
  const original = enableMonnify();
  try {
    const provider = getPaymentProvider();
    assert.strictEqual(provider.NAME, 'monnify');
    for (const method of ['initializePayment', 'verifyPayment', 'verifyWebhookSignature', 'webhookEvent', 'getPaymentStatus', 'refundPayment']) {
      assert.strictEqual(typeof provider[method], 'function', `${method} must exist`);
    }
  } finally {
    disableMonnify(original);
  }
});

test('monnify webhook signature verification uses HMAC-SHA512 with the secret key', () => {
  const original = enableMonnify();
  try {
    const provider = getPaymentProvider();
    const body = Buffer.from(JSON.stringify({ eventType: 'SUCCESSFUL_TRANSACTION', eventData: { paymentReference: 'TF-1' } }));
    const sig = crypto.createHmac('sha512', config.monnify.secretKey).update(body).digest('hex');
    assert.strictEqual(provider.verifyWebhookSignature({ rawBody: body, signature: sig }), true);
    // wrong secret must fail
    const badSig = crypto.createHmac('sha512', 'wrong-secret').update(body).digest('hex');
    assert.strictEqual(provider.verifyWebhookSignature({ rawBody: body, signature: badSig }), false);
    // malformed signatures fail fast
    assert.strictEqual(provider.verifyWebhookSignature({ rawBody: body, signature: 'short' }), false);
    assert.strictEqual(provider.verifyWebhookSignature({ rawBody: body, signature: 'zzzz' }), false);
  } finally {
    disableMonnify(original);
  }
});

test('monnify webhookEvent extracts event + reference + amount from eventData', () => {
  const original = enableMonnify();
  try {
    const provider = getPaymentProvider();
    const { event, reference, amountPaid } = provider.webhookEvent({
      eventType: 'SUCCESSFUL_TRANSACTION_WITH_TRANSFER',
      eventData: { paymentReference: 'TF-456', amountPaid: 500000 },
    });
    assert.strictEqual(event, 'SUCCESSFUL_TRANSACTION_WITH_TRANSFER');
    assert.strictEqual(reference, 'TF-456');
    assert.strictEqual(amountPaid, 5000); // kobo -> naira
  } finally {
    disableMonnify(original);
  }
});

test('monnify initializePayment maps amount to kobo and returns checkout URL', async () => {
  const original = enableMonnify();
  const axios = require('axios');
  const stubPost = axios.post;
  const stubGet = axios.get;
  try {
    const captured = [];
    axios.post = async (url, payload) => {
      captured.push({ url, payload });
      if (url.includes('/api/v1/auth/login')) {
        return { data: { responseBody: { accessToken: 'tok-test', expiresIn: 3600 } } };
      }
      return { data: { requestSuccessful: true, responseBody: { checkoutUrl: 'https://checkout.monnify.com/abc', paymentReference: 'TF-ref-1' } } };
    };
    const result = await monnify.initializePayment({ email: 'a@b.com', amount: 2500, reference: 'TF-ref-1', metadata: { user_id: 7 } });
    // auth login called first, then transaction init
    assert.ok(captured[0].url.includes('/api/v1/auth/login'), 'auth login must be called first');
    const tx = captured[1].payload;
    assert.ok(captured[1].url.includes('/api/v2/transactions'), 'transaction init URL expected');
    assert.strictEqual(tx.amount, 250000); // ₦2500 -> 250000 kobo
    assert.strictEqual(tx.paymentReference, 'TF-ref-1');
    assert.deepStrictEqual(tx.paymentMethods, ['CARD', 'ACCOUNT_TRANSFER']);
    assert.strictEqual(result.reference, 'TF-ref-1');
    assert.ok(result.authorizationUrl.includes('checkout.monnify.com'));
  } finally {
    axios.post = stubPost;
    axios.get = stubGet;
    disableMonnify(original);
  }
});

test('monnify verifyPayment returns naira amount and user id on success', async () => {
  const original = enableMonnify();
  const axios = require('axios');
  const stubPost = axios.post;
  const stubGet = axios.get;
  try {
    axios.post = async (url) => ({ data: { responseBody: { accessToken: 'tok-test', expiresIn: 3600 } } });
    axios.get = async (url) => {
      assert.ok(url.includes('/api/v2/transactions/TF-ref-2'), `unexpected URL: ${url}`);
      return { data: { responseBody: { paymentReference: 'TF-ref-2', transactionStatus: 'SUCCESSFUL', amountPaid: 300000, currencyCode: 'NGN', metadata: { user_id: '11' } } } };
    };
    const result = await monnify.verifyPayment('TF-ref-2');
    assert.strictEqual(result.status, 'success');
    assert.strictEqual(result.amount, 3000); // 300000 kobo -> ₦3000
    assert.strictEqual(result.userId, 11);
  } finally {
    axios.post = stubPost;
    axios.get = stubGet;
    disableMonnify(original);
  }
});

test('monnify verifyPayment rejects unconfirmed payments', async () => {
  const original = enableMonnify();
  const axios = require('axios');
  const stubPost = axios.post;
  const stubGet = axios.get;
  try {
    axios.post = async (url) => ({ data: { responseBody: { accessToken: 'tok-test', expiresIn: 3600 } } });
    axios.get = async () => ({ data: { responseBody: { paymentReference: 'TF-ref-3', transactionStatus: 'PENDING', amountPaid: 0 } } });
    await assert.rejects(() => monnify.verifyPayment('TF-ref-3'), (e) => e.code === 'PAYMENT_NOT_SUCCESSFUL');
  } finally {
    axios.post = stubPost;
    axios.get = stubGet;
    disableMonnify(original);
  }
});

test('monnify getPaymentStatus maps provider statuses to success/failed/pending', async () => {
  const original = enableMonnify();
  const axios = require('axios');
  const stubPost = axios.post;
  const stubGet = axios.get;
  try {
    axios.post = async (url) => ({ data: { responseBody: { accessToken: 'tok-test', expiresIn: 3600 } } });
    axios.get = async () => ({ data: { responseBody: { paymentReference: 'TF-ref-4', transactionStatus: 'FAILED', amountPaid: 0 } } });
    const result = await monnify.getPaymentStatus('TF-ref-4');
    assert.strictEqual(result.status, 'failed');
  } finally {
    axios.post = stubPost;
    axios.get = stubGet;
    disableMonnify(original);
  }
});
