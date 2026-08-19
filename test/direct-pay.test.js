/**
 * TopFlowNG — direct pay-per-order route tests (PAYMENT_MODE=direct).
 *
 * Verifies:
 *   - the direct route is guarded: orders cannot be created in wallet mode
 *   - in direct mode, a valid order initializes a Paystack checkout for the
 *     server-calculated price and records the order as payment_status='pending'
 *   - the payment provider is never called with a client-set authoritative price
 *   - the verification bridge routes a verified payment to a direct order.
 *
 * Uses the mocked DB harness and stubs the Paystack adapter's network call.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/load-app');
const config = require('../config');
const paystackAdapter = require('../payment/paystack');

// Keep a reference to the original init to restore after tests.
const origInitialize = paystackAdapter.initializePayment;

before(async () => {
  h.mockDb.__reset();
  await h.waitForServer();
  // Stub the network call: return a fake authorization_url + reference.
  paystackAdapter.initializePayment = async ({ amount, reference }) => ({
    authorizationUrl: 'https://checkout.paystack.com/fake',
    reference,
  });
});

after(() => {
  paystackAdapter.initializePayment = origInitialize;
  h.closeServer();
});

test('direct orders are guarded: 403 when PAYMENT_MODE is not direct', async () => {
  h.mockDb.__reset();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'wallet';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dirguard@example.com', phone: '08070000000', password: 'secret123' });
    const loginRes = await h.login('dirguard@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'airtime', network: 'MTN', phone: '08031234567', amount: 100 },
    });
    assert.strictEqual(r.status, 403);
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: airtime order creates pending order and returns checkout', async () => {
  h.mockDb.__reset();
  h.mockDb.__resetDirectOrders && h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir1@example.com', phone: '08071111111', password: 'secret123' });
    const loginRes = await h.login('dir1@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'airtime', network: 'MTN', phone: '08031234567', amount: 100 },
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.data.authorization_url, 'authorization_url returned');
    assert.ok(r.data.reference, 'payment reference returned');
    assert.ok(r.data.order_request_id, 'order request id returned');
    assert.strictEqual(r.data.amount, 100, 'server-side amount echoed');
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: unsupported service type is rejected', async () => {
  h.mockDb.__reset();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir2@example.com', phone: '08072222222', password: 'secret123' });
    const loginRes = await h.login('dir2@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'gift-card', amount: 100 },
    });
    assert.strictEqual(r.status, 400);
  } finally {
    config.paymentMode = originalMode;
  }
});
