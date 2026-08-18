/**
 * TopFlowNG — wallet, authorization and pricing integrity tests.
 *
 * Runs the real server and the real database against a throwaway Postgres with
 * only the provider and email layers mocked. Covers the invariants that protect
 * customer money and customer data:
 *
 *   - the wallet can never go negative, even under concurrent debits
 *   - one user can never read or mutate another user's records (IDOR)
 *   - the client can never choose the price of a plan (amount tampering) on the
 *     interactive routes OR on scheduled purchases
 *   - products that are not verified+enabled on the provider (NECO, NABTEB,
 *     recharge-card PINs) can never be purchased or debited
 *
 * No real external service is ever contacted and no real money moves.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/load-idempotency-app');

let db;
let tokenA; let userIdA;
let tokenB; let userIdB;

before(async () => {
  db = require('../database');
  await h.waitForServer();
  h.applyMigrations();

  const regA = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'IT Ada', email: 'itada' + process.pid + '@example.com', phone: '08093000001', password: 'secret123' },
  });
  assert.strictEqual(regA.status, 201);
  tokenA = regA.data.token;
  userIdA = regA.data.user.id;
  await db.setTransactionPin(userIdA, '1111');
  await db.creditWallet(userIdA, 100000, 'seed', 'seed-IT-A');

  const regB = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'IT Bola', email: 'itbola' + process.pid + '@example.com', phone: '08093000002', password: 'secret123' },
  });
  assert.strictEqual(regB.status, 201);
  tokenB = regB.data.token;
  userIdB = regB.data.user.id;
  await db.setTransactionPin(userIdB, '1111');
  await db.creditWallet(userIdB, 100000, 'seed', 'seed-IT-B');
});

after(async () => {
  await h.cleanup();
});

// ── Wallet integrity ─────────────────────────────────────────────────────────

test('wallet: a debit larger than the balance is refused and changes nothing', async () => {
  const before = await db.getWalletBalance(userIdA);
  await assert.rejects(
    () => db.debitWallet(userIdA, before + 1, 'overdraw attempt', 'IT-OVERDRAW'),
    /Insufficient balance/,
  );
  assert.strictEqual(await db.getWalletBalance(userIdA), before);
});

test('wallet: concurrent debits never drive the balance below zero', async () => {
  const reg = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'IT Chidi', email: 'itchidi' + process.pid + '@example.com', phone: '08093000003', password: 'secret123' },
  });
  const userId = reg.data.user.id;
  await db.creditWallet(userId, 1000, 'seed', 'seed-IT-CONC');

  // Ten parallel ₦200 debits against a ₦1,000 balance: at most five may win.
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, (_, i) => db.debitWallet(userId, 200, 'concurrent debit', `IT-CONC-${i}`))
  );
  const settled = results.filter((r) => r.status === 'fulfilled').length;

  assert.strictEqual(settled, 5, 'exactly five ₦200 debits fit in a ₦1,000 balance');
  const balance = await db.getWalletBalance(userId);
  assert.strictEqual(balance, 0);
  assert.ok(balance >= 0, 'wallet must never be negative');
});

test('wallet: purchase is refused when the balance is short, with no debit', async () => {
  const reg = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'IT Dayo', email: 'itdayo' + process.pid + '@example.com', phone: '08093000004', password: 'secret123' },
  });
  const token = reg.data.token;
  await db.setTransactionPin(reg.data.user.id, '1111');
  await db.creditWallet(reg.data.user.id, 100, 'seed', 'seed-IT-SHORT');

  const res = await h.api('POST', '/api/vtu/airtime', {
    token, body: { network: 'MTN', phone: '08031234567', amount: 5000, pin: '1111' },
  });
  assert.strictEqual(res.status, 402);
  assert.strictEqual(await db.getWalletBalance(reg.data.user.id), 100);
});

// ── Authorization / IDOR ─────────────────────────────────────────────────────

test('IDOR: user B cannot read or delete user A\'s beneficiary', async () => {
  const created = await h.api('POST', '/api/beneficiaries', {
    token: tokenA,
    body: { type: 'airtime', label: 'Ada line', network: 'MTN', identifier: '08031111111' },
  });
  assert.strictEqual(created.status, 200);
  const beneficiaryId = created.data.beneficiary.id;

  const listB = await h.api('GET', '/api/beneficiaries', { token: tokenB });
  assert.strictEqual(listB.status, 200);
  assert.ok(
    !listB.data.beneficiaries.some((b) => b.id === beneficiaryId),
    "user B must not see user A's beneficiaries",
  );

  const del = await h.api('DELETE', `/api/beneficiaries/${beneficiaryId}`, { token: tokenB });
  assert.strictEqual(del.status, 404, "deleting another user's beneficiary must 404");

  const listA = await h.api('GET', '/api/beneficiaries', { token: tokenA });
  assert.ok(
    listA.data.beneficiaries.some((b) => b.id === beneficiaryId),
    'the record must still belong to user A',
  );
});

test('IDOR: user B cannot cancel user A\'s scheduled purchase', async () => {
  const created = await h.api('POST', '/api/scheduled-purchases', {
    token: tokenA,
    body: {
      serviceType: 'airtime', network: 'MTN', phone: '08031111111',
      amount: 500, frequency: 'weekly',
      nextRunAt: new Date(Date.now() + 86400000).toISOString(),
      pin: '1111',
    },
  });
  assert.strictEqual(created.status, 201);
  const id = created.data.purchase.id;

  const listB = await h.api('GET', '/api/scheduled-purchases', { token: tokenB });
  assert.ok(!listB.data.scheduled.some((s) => s.id === id));

  const paused = await h.api('PATCH', `/api/scheduled-purchases/${id}/status`, {
    token: tokenA, body: { active: false },
  });
  assert.strictEqual(paused.status, 200);
  assert.strictEqual(paused.data.purchase.active, false);
  const resumed = await h.api('PATCH', `/api/scheduled-purchases/${id}/status`, {
    token: tokenA, body: { active: true },
  });
  assert.strictEqual(resumed.status, 200);
  assert.strictEqual(resumed.data.purchase.active, true);

  const foreignPause = await h.api('PATCH', `/api/scheduled-purchases/${id}/status`, {
    token: tokenB, body: { active: false },
  });
  assert.strictEqual(foreignPause.status, 404);

  const del = await h.api('DELETE', `/api/scheduled-purchases/${id}`, { token: tokenB });
  assert.strictEqual(del.status, 404);
});

test('IDOR: transactions are scoped to the authenticated user', async () => {
  const txA = await h.api('GET', '/api/wallet/transactions', { token: tokenA });
  const txB = await h.api('GET', '/api/wallet/transactions', { token: tokenB });
  assert.strictEqual(txA.status, 200);
  assert.strictEqual(txB.status, 200);
  const refsB = txB.data.transactions.map((t) => t.reference);
  assert.ok(!refsB.includes('seed-IT-A'), "user B must not see user A's ledger");
});

test('IDOR: a non-admin cannot reach admin endpoints', async () => {
  for (const path of ['/api/admin/stats', '/api/admin/users', '/api/admin/transactions', '/api/admin/reconciliation']) {
    const res = await h.api('GET', path, { token: tokenB });
    assert.strictEqual(res.status, 403, `${path} must be admin-only`);
  }
});

// ── Amount tampering ─────────────────────────────────────────────────────────

test('pricing: a data plan cannot be bought below its catalog price', async () => {
  const before = await db.getWalletBalance(userIdA);
  const res = await h.api('POST', '/api/vtu/data', {
    token: tokenA,
    body: { network: 'MTN', phone: '08031234567', planCode: 'MTN14GB', amount: 1, pin: '1111' },
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /mismatch/i);
  assert.strictEqual(await db.getWalletBalance(userIdA), before);
});

test('pricing: a cable bouquet cannot be bought below its catalog price', async () => {
  const before = await db.getWalletBalance(userIdA);
  const res = await h.api('POST', '/api/vtu/cable', {
    token: tokenA,
    body: { provider: 'DSTV', smartCardNumber: '1234567890', planCode: 'DSTV_PREMIUM', amount: 100, pin: '1111' },
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /mismatch/i);
  assert.strictEqual(await db.getWalletBalance(userIdA), before);
});

test('pricing: a cable bouquet at its catalog price is accepted', async () => {
  const res = await h.api('POST', '/api/vtu/cable', {
    token: tokenA,
    body: { provider: 'GOTV', smartCardNumber: '1234567890', planCode: 'GOTV_JOLLI', amount: 5800, pin: '1111' },
  });
  assert.ok([200, 202].includes(res.status), `expected success/pending, got ${res.status}`);
});

test('pricing: a scheduled data purchase cannot store a tampered amount', async () => {
  const res = await h.api('POST', '/api/scheduled-purchases', {
    token: tokenA,
    body: {
      serviceType: 'data', network: 'MTN', planCode: 'MTN14GB', phone: '08031234567',
      amount: 1, frequency: 'monthly',
      nextRunAt: new Date(Date.now() + 86400000).toISOString(),
      pin: '1111',
    },
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.data.error, /mismatch/i);
});

test('scheduling: unknown service types and frequencies are rejected', async () => {
  const badType = await h.api('POST', '/api/scheduled-purchases', {
    token: tokenA,
    body: {
      serviceType: 'bitcoin', amount: 500, frequency: 'weekly',
      nextRunAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  assert.strictEqual(badType.status, 400);

  const badFreq = await h.api('POST', '/api/scheduled-purchases', {
    token: tokenA,
    body: {
      serviceType: 'airtime', network: 'MTN', phone: '08031234567',
      amount: 500, frequency: 'hourly',
      nextRunAt: new Date(Date.now() + 86400000).toISOString(),
    },
  });
  assert.strictEqual(badFreq.status, 400);
});

test('auto-recharge: out-of-range thresholds and amounts are rejected', async () => {
  const tooSmall = await h.api('POST', '/api/auto-recharge', {
    token: tokenA, body: { threshold: 10, amount: 1000 },
  });
  assert.strictEqual(tooSmall.status, 400);

  const tooBig = await h.api('POST', '/api/auto-recharge', {
    token: tokenA, body: { threshold: 500, amount: 99999999 },
  });
  assert.strictEqual(tooBig.status, 400);
});

// ── Disabled products stay unpurchasable ─────────────────────────────────────

for (const body of ['NECO', 'NABTEB']) {
  test(`products: ${body} exam PINs are refused with no wallet debit`, async () => {
    const before = await db.getWalletBalance(userIdA);
    const res = await h.api('POST', '/api/vtu/exam-pin', {
      token: tokenA, body: { examBody: body, quantity: 1, pin: '1111' },
    });
    assert.strictEqual(res.status, 400);
    assert.match(res.data.error, /not available/i);
    assert.strictEqual(await db.getWalletBalance(userIdA), before, 'no debit for an unavailable product');
  });
}

test('products: WAEC exam PINs are accepted (verified + enabled)', async () => {
  const res = await h.api('POST', '/api/vtu/exam-pin', {
    token: tokenA, body: { examBody: 'WAEC', quantity: 1, pin: '1111' },
  });
  assert.ok([200, 202].includes(res.status), `expected success/pending, got ${res.status}`);
});

test('products: the exam catalog never prices a disabled body', async () => {
  const res = await h.api('GET', '/api/vtu/plans');
  assert.strictEqual(res.status, 200);
  const { examPrices, examProducts } = res.data;
  assert.ok(examPrices.WAEC, 'WAEC is priced');
  assert.ok(!examPrices.JAMB, 'JAMB is not priced while provider returns no variations');
  assert.strictEqual(examPrices.NECO, undefined, 'NECO must not be priced');
  assert.strictEqual(examPrices.NABTEB, undefined, 'NABTEB must not be priced');

  for (const product of examProducts) {
    if (!product.enabled) {
      assert.strictEqual(product.price, null, `${product.code} must not advertise a price`);
      assert.ok(product.reason, `${product.code} must explain why it is unavailable`);
    }
  }
});

test('products: JAMB stays disabled when the live provider has no purchasable variations', async () => {
  const res = await h.api('GET', '/api/vtu/plans');
  assert.strictEqual(res.data.examPrices.JAMB, undefined);
});
