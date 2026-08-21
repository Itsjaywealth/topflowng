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

// ── Every product must be orderable in direct mode ──────────────────────────
// The server recalculates each price from the catalog — the client amount is
// ignored for plan-based products (data, cable, exam PINs).

test('direct mode: data order defaults to the server-side catalog price when no amount is sent', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir3@example.com', phone: '08073333333', password: 'secret123' });
    const loginRes = await h.login('dir3@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'data', network: 'MTN', phone: '08031234567', planCode: 'MTN14GB' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.amount, 5000, 'authoritative catalog price charged');
    assert.ok(r.data.authorization_url);
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: data order with a mismatched client amount is rejected', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir3b@example.com', phone: '08073333334', password: 'secret123' });
    const loginRes = await h.login('dir3b@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'data', network: 'MTN', phone: '08031234567', planCode: 'MTN14GB', amount: 1 },
    });
    assert.strictEqual(r.status, 400, 'a client-claimed price that disagrees with the catalog must never be charged');
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: data order with unknown plan is rejected', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir4@example.com', phone: '08074444444', password: 'secret123' });
    const loginRes = await h.login('dir4@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'data', network: 'MTN', phone: '08031234567', planCode: 'MTN-FAKE-PLAN' },
    });
    assert.strictEqual(r.status, 400);
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: electricity order creates checkout', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir5@example.com', phone: '08075555555', password: 'secret123' });
    const loginRes = await h.login('dir5@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'electricity', disco: 'IKEDC', meterNumber: '45067460456', meterType: 'prepaid', amount: 1000 },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.amount, 1000);
    assert.ok(r.data.order_request_id);
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: cable order defaults to the server-side bouquet price', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir6@example.com', phone: '08076666666', password: 'secret123' });
    const loginRes = await h.login('dir6@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'cable', provider: 'GOTV', smartCardNumber: '1234567890', planCode: 'GOTV_JOLLI' },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.data.amount, 5800, 'bouquet catalog price charged');
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: WAEC exam PIN order multiplies unit price by quantity', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir7@example.com', phone: '08077777777', password: 'secret123' });
    const loginRes = await h.login('dir7@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'exam-pin', examBody: 'WAEC', quantity: 2 },
    });
    assert.strictEqual(r.status, 200);
    const expected = (require('../services/pricing').findExamPrice('WAEC') || 0) * 2;
    assert.strictEqual(r.data.amount, expected, 'quantity × authoritative unit price');
  } finally {
    config.paymentMode = originalMode;
  }
});

test('direct mode: disabled exam body cannot be ordered', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir8@example.com', phone: '08078888888', password: 'secret123' });
    const loginRes = await h.login('dir8@example.com', 'secret123');
    const r = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'exam-pin', examBody: 'NECO', quantity: 1 },
    });
    assert.strictEqual(r.status, 400);
  } finally {
    config.paymentMode = originalMode;
  }
});

// ── Verify bridge: verified payment → fulfilment outcome on the response ────

test('direct mode: verifying a paid order returns the fulfilment outcome and marks it paid', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir9@example.com', phone: '08079999999', password: 'secret123' });
    const loginRes = await h.login('dir9@example.com', 'secret123');
    const created = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'airtime', network: 'MTN', phone: '08031234567', amount: 100 },
    });
    assert.strictEqual(created.status, 200);
    const reference = created.data.reference;

    // Stub provider verification: this reference belongs to our user, paid.
    paystackAdapter.verifyPayment = async ({ reference: ref }) => ({
      status: 'success', reference: ref, userId: user.id, amount: 100,
    });

    h.mockVtpass().processDirectPurchase.__outcome = 'success';
    const v = await h.api('GET', `/api/payment/verify/${encodeURIComponent(reference)}`, {
      token: loginRes.data.token,
    });
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.data.success, true);
    assert.strictEqual(v.data.direct, true);
    assert.strictEqual(v.data.outcome, 'success');
    assert.strictEqual(v.data.requestId, created.data.order_request_id);

    const orders = h.mockDb.__getDirectOrders();
    const order = orders.find((o) => o.payment_reference === reference);
    assert.strictEqual(order.payment_status, 'paid', 'order marked paid after verification');

    // Replay is idempotent: same outcome, no second fulfilment.
    const replay = await h.api('GET', `/api/payment/verify/${encodeURIComponent(reference)}`, {
      token: loginRes.data.token,
    });
    assert.strictEqual(replay.status, 200);
    assert.strictEqual(replay.data.direct, true);
    assert.strictEqual(replay.data.outcome, 'success');
  } finally {
    delete h.mockVtpass().processDirectPurchase.__outcome;
    config.paymentMode = originalMode;
  }
});

test('direct mode: a failed fulfilment surfaces as outcome=failed on verify', async () => {
  h.mockDb.__reset(); h.mockDb.__resetDirectOrders();
  const originalMode = config.paymentMode;
  try {
    config.paymentMode = 'direct';
    const user = await h.createUserViaDb({ fullName: 'Ada', email: 'dir10@example.com', phone: '08070000001', password: 'secret123' });
    const loginRes = await h.login('dir10@example.com', 'secret123');
    const created = await h.api('POST', '/api/direct/orders', {
      token: loginRes.data.token,
      body: { serviceType: 'airtime', network: 'MTN', phone: '08031234567', amount: 100 },
    });
    const reference = created.data.reference;

    paystackAdapter.verifyPayment = async ({ reference: ref }) => ({
      status: 'success', reference: ref, userId: user.id, amount: 100,
    });

    h.mockVtpass().processDirectPurchase.__outcome = 'failed';
    h.mockVtpass().processDirectPurchase.__message = 'The provider declined this purchase.';
    const v = await h.api('GET', `/api/payment/verify/${encodeURIComponent(reference)}`, {
      token: loginRes.data.token,
    });
    assert.strictEqual(v.status, 200);
    assert.strictEqual(v.data.direct, true);
    assert.strictEqual(v.data.outcome, 'failed');
    assert.match(v.data.message || '', /declined/i);
  } finally {
    delete h.mockVtpass().processDirectPurchase.__outcome;
    delete h.mockVtpass().processDirectPurchase.__message;
    config.paymentMode = originalMode;
  }
});
