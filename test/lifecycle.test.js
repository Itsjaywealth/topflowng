/**
 * TopFlowNG — Phase 4E VTU status-transition, reconciliation and rollback
 * safety tests.
 *
 * Runs against the real throwaway PostgreSQL database with a mocked provider.
 * Verifies the status-transition matrix (pending/processing/completed/failed),
 * terminal-state rejection, idempotent re-completion, reconciliation attempt
 * tracking, at-most-once wallet debit under duplicates/concurrency, and atomic
 * rollback when a wallet debit or ledger write fails. Phase 4D idempotency
 * behaviour is regression-tested at the route level.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const h = require('./helpers/load-idempotency-app');

let db;
const { reconcileVtuOrder, scheduledProcessorHooks } = require('../server');
let tokenA;  // admin session (reconcile tests)
let tokenB;  // funded non-admin session
let userIdB; // funded non-admin user
let userIdC; // zero-balance user (rollback tests)

let orderSeq = 0;
const orderId = (tag) => `LC-${process.pid}-${tag}-${++orderSeq}`;

async function createPendingOrder(requestId, userId, amount, { withProviderId = true } = {}) {
  await db.createVtuAttempt({
    requestId,
    userId,
    serviceType: 'airtime',
    amount,
    description: `Lifecycle test ${requestId}`,
  });
  if (withProviderId) {
    await db.recordVtuProviderResponse(requestId, {
      orderId: `LC-ORDER-${requestId}`,
      statusCode: 199,
      status: 'ORDER_RECEIVED',
      remark: 'On hold',
      description: 'Pending provider confirmation',
      raw: {},
    });
  }
  await db.markVtuOrderPending(requestId);
  return db.getVtuOrderByRequestId(requestId);
}

async function debitRows(requestId) {
  const pool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS total, status
       FROM transactions WHERE reference = $1 AND type = 'debit' GROUP BY status`,
      [requestId]
    );
    return rows;
  } finally {
    await pool.end();
  }
}

async function walletOf(userId) {
  return db.getWalletBalance(userId);
}

before(async () => {
  db = require('../database');
  await h.waitForServer();
  h.applyMigrations();

  const regA = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'LC Ada', email: 'lcada' + process.pid + '@example.com', phone: '08091000001', password: 'secret123' },
  });
  assert.strictEqual(regA.status, 201);
  tokenA = regA.data.token;
  await db.setTransactionPin(regA.data.user.id, '1111');
  await db.creditWallet(regA.data.user.id, 500000, 'seed', 'seed-A');
  // Promote A to admin so the reconcile endpoint can be exercised.
  await db.promoteToAdmin(regA.data.user.id);

  const regB = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'LC Bola', email: 'lcbola' + process.pid + '@example.com', phone: '08091000002', password: 'secret123' },
  });
  assert.strictEqual(regB.status, 201);
  tokenB = regB.data.token;
  userIdB = regB.data.user.id;
  await db.setTransactionPin(userIdB, '1111');
  await db.creditWallet(userIdB, 500000, 'seed', 'seed-B');

  const regC = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'LC Chidi', email: 'lcchidi' + process.pid + '@example.com', phone: '08091000003', password: 'secret123' },
  });
  assert.strictEqual(regC.status, 201);
  userIdC = regC.data.user.id;
  await db.setTransactionPin(userIdC, '1111');
});

after(async () => {
  await h.cleanup();
});

// ── 1. pending → completed is the valid settlement path ──────────────────────
test('1. pending order completes with allowPending and debits once', async () => {
  const rid = orderId('P2C');
  await createPendingOrder(rid, userIdB, 2000);
  const balBefore = await walletOf(userIdB);

  const result = await db.completeVtuOrder(rid, { allowPending: true });
  assert.strictEqual(result.alreadyCompleted, false);
  assert.strictEqual(result.balance, balBefore - 2000);

  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'completed');
  assert.ok(order.provider_order_id, 'provider reference preserved');
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000, 'debited exactly once');
});

// ── 2. pending → failed is the valid decline path ────────────────────────────
test('2. pending order fails without any wallet debit', async () => {
  const rid = orderId('P2F');
  await createPendingOrder(rid, userIdB, 2000);
  const balBefore = await walletOf(userIdB);

  await db.markVtuOrderFailed(rid, { allowPending: true });
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'failed');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'wallet untouched on failure');
});

// ── 3. completed → pending is rejected ───────────────────────────────────────
test('3. completed order cannot be moved back to pending', async () => {
  const rid = orderId('C2P');
  await createPendingOrder(rid, userIdB, 2000);
  await db.completeVtuOrder(rid, { allowPending: true });
  await assert.rejects(() => db.markVtuOrderPending(rid), /terminal|Illegal VTU order transition/i);
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'completed');
});

// ── 4. completed → failed is rejected ────────────────────────────────────────
test('4. completed order cannot be flipped to failed', async () => {
  const rid = orderId('C2F');
  await createPendingOrder(rid, userIdB, 2000);
  await db.completeVtuOrder(rid, { allowPending: true });
  await assert.rejects(() => db.markVtuOrderFailed(rid), /terminal|Illegal VTU order transition/i);
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'completed');
});

// ── 5. failed → completed is rejected ────────────────────────────────────────
test('5. failed order cannot be resurrected to completed', async () => {
  const rid = orderId('F2C');
  const balBefore = await walletOf(userIdB);
  await createPendingOrder(rid, userIdB, 2000);
  await db.markVtuOrderFailed(rid, { allowPending: true });
  await assert.rejects(() => db.completeVtuOrder(rid, { allowPending: true }), /failed|transition/i);
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'failed');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'no debit on rejected resurrection');
});

// ── 6. duplicate completion is idempotent ────────────────────────────────────
test('6. duplicate completion is idempotent: no second debit', async () => {
  const rid = orderId('DUP');
  await createPendingOrder(rid, userIdB, 2000);
  const balBefore = await walletOf(userIdB);

  const first = await db.completeVtuOrder(rid, { allowPending: true });
  const second = await db.completeVtuOrder(rid, { allowPending: true });
  assert.strictEqual(first.alreadyCompleted, false);
  assert.strictEqual(second.alreadyCompleted, true);
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000, 'debited exactly once across duplicates');

  const rows = await debitRows(rid);
  assert.strictEqual(rows.length, 1, 'one ledger row total');
  assert.strictEqual(rows[0].status, 'completed');
  assert.strictEqual(Number(rows[0].n), 1);
  assert.strictEqual(Number(rows[0].total), 2000);
});

// ── 7. reconciliation end-to-end: attempts tracked, single debit ─────────────
test('7. reconcile endpoint settles once, tracks attempts, no re-debit', async () => {
  h.providerState.reset();
  const rid = orderId('RECON');
  await createPendingOrder(rid, userIdB, 2000);
  const balBefore = await walletOf(userIdB);

  // First reconcile: provider still pending → order stays pending.
  h.providerState.queryOutcome = 'pending';
  const r1 = await h.api('POST', `/api/admin/vtu-orders/${rid}/reconcile`, { token: tokenA });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.data.outcome, 'pending');
  assert.strictEqual(r1.data.order.status, 'pending');
  assert.strictEqual(r1.data.order.reconcile_attempts, 1);
  assert.strictEqual(await walletOf(userIdB), balBefore, 'no debit while still pending');

  // Second reconcile: provider confirms success → settles exactly once.
  h.providerState.queryOutcome = 'success';
  const r2 = await h.api('POST', `/api/admin/vtu-orders/${rid}/reconcile`, { token: tokenA });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.data.outcome, 'success');
  assert.strictEqual(r2.data.order.status, 'completed');
  assert.strictEqual(r2.data.order.reconcile_attempts, 2);
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000, 'single debit after confirmation');
  assert.strictEqual(h.providerState.queryCalls, 2);

  // Third reconcile: terminal state short-circuits; no query, no re-debit.
  h.providerState.queryCalls = 0;
  const r3 = await h.api('POST', `/api/admin/vtu-orders/${rid}/reconcile`, { token: tokenA });
  assert.strictEqual(r3.status, 200);
  assert.strictEqual(r3.data.outcome, 'completed');
  assert.strictEqual(h.providerState.queryCalls, 0, 'no provider query on terminal order');
  assert.strictEqual(r3.data.order.reconcile_attempts, 2, 'attempts unchanged on terminal short-circuit');
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000);
});

// ── 8. pending order without a provider ID is safely rejected ────────────────
// ── 8. reconcile requeries by request_id (no provider id needed) ─────────────
test('8. reconcile of order without provider_order_id requeries by request_id', async () => {
  h.providerState.reset();
  const rid = orderId('NOPID');
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: false });
  const balBefore = await walletOf(userIdB);

  const r = await h.api('POST', `/api/admin/vtu-orders/${rid}/reconcile`, { token: tokenA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.outcome, 'pending');
  assert.strictEqual(h.providerState.queryCalls, 1, 'requery by request_id is supported');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'no debit');
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'pending');
});

// ── 9. provider success + local failure leaves a recoverable pending order ───
test('9. local settlement failure after provider success keeps order recoverable', async () => {
  const rid = orderId('RECOV');
  await db.createVtuAttempt({
    requestId: rid,
    userId: userIdC, // zero balance → debit will fail
    serviceType: 'airtime',
    amount: 2000,
    description: `Lifecycle test ${rid}`,
  });
  await db.recordVtuProviderResponse(rid, {
    orderId: `LC-ORDER-${rid}`,
    statusCode: 200,
    status: 'ORDER_COMPLETED',
    remark: 'Success',
    description: 'Delivered',
    raw: {},
  });

  // Provider says delivered but the wallet cannot be debited.
  await assert.rejects(() => db.completeVtuOrder(rid), /Insufficient balance/);
  let order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'submitted', 'failed settlement rolled back cleanly');
  assert.strictEqual(await walletOf(userIdC), 0, 'no partial debit');

  // Park in the reconcilable pending state with the provider reference intact.
  await db.markVtuOrderPending(rid);
  order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'pending');
  assert.ok(order.provider_order_id, 'provider reference preserved for reconciliation');

  // Once funded, reconciliation settles it in the normal way.
  await db.creditWallet(userIdC, 5000, 'topup', 'topup-C');
  const settled = await db.completeVtuOrder(rid, { allowPending: true });
  assert.strictEqual(settled.alreadyCompleted, false);
  order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'completed');
  assert.strictEqual(await walletOf(userIdC), 5000 - 2000, 'single debit after recovery');
});

// ── 10. wallet debit failure rolls back the whole settlement ─────────────────
test('10. failed wallet debit leaves no partial transaction state', async () => {
  const rid = orderId('WDEBIT');
  // Reset the zero-balance user's wallet (test 9 funded it) so the debit below
  // genuinely cannot be satisfied.
  const resetPool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    await resetPool.query('UPDATE users SET wallet = 0 WHERE id = $1', [userIdC]);
  } finally {
    await resetPool.end();
  }
  await db.createVtuAttempt({
    requestId: rid,
    userId: userIdC, // zero balance
    serviceType: 'airtime',
    amount: 2000,
    description: `Lifecycle test ${rid}`,
  });

  await assert.rejects(() => db.completeVtuOrder(rid), /Insufficient balance/);
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'submitted', 'status unchanged after rollback');
  assert.strictEqual(await walletOf(userIdC), 0, 'wallet unchanged after rollback');

  const rows = await debitRows(rid);
  assert.strictEqual(rows.length, 0, 'no ledger rows leaked from a rolled-back settlement');
});

// ── 11. ledger insert failure rolls back the wallet debit ────────────────────
test('11. transaction insert failure rolls back the wallet debit', async () => {
  const rid = orderId('LEDGER');
  await db.createVtuAttempt({
    requestId: rid,
    userId: userIdB,
    serviceType: 'airtime',
    amount: 2000,
    description: `Lifecycle test ${rid}`,
  });
  const balBefore = await walletOf(userIdB);

  const pool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    // Force every INSERT into transactions to fail inside the settlement txn.
    await pool.query(
      `CREATE OR REPLACE FUNCTION tf_inject_ledger_failure() RETURNS trigger AS $$
       BEGIN RAISE EXCEPTION 'injected ledger failure'; END; $$ LANGUAGE plpgsql`
    );
    await pool.query(
      `CREATE TRIGGER trg_inject_ledger_failure BEFORE INSERT ON transactions
       FOR EACH ROW EXECUTE FUNCTION tf_inject_ledger_failure()`
    );

    await assert.rejects(() => db.completeVtuOrder(rid), /injected ledger failure/);
  } finally {
    await pool.query('DROP TRIGGER IF EXISTS trg_inject_ledger_failure ON transactions').catch(() => {});
    await pool.query('DROP FUNCTION IF EXISTS tf_inject_ledger_failure()').catch(() => {});
    await pool.end();
  }

  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'submitted', 'order not completed after rolled-back settlement');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'wallet debit rolled back');
  const rows = await debitRows(rid);
  assert.strictEqual(rows.length, 0, 'no completed ledger row leaked');

  // With the failure removed the same order settles normally (single debit).
  const settled = await db.completeVtuOrder(rid);
  assert.strictEqual(settled.alreadyCompleted, false);
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000);
});

// ── 12. concurrent reconciliation produces exactly one completion ────────────
test('12. concurrent reconcile settles exactly once', async () => {
  const rid = orderId('CONC');
  await createPendingOrder(rid, userIdB, 2000);
  const balBefore = await walletOf(userIdB);

  const results = await Promise.all([
    db.completeVtuOrder(rid, { allowPending: true }),
    db.completeVtuOrder(rid, { allowPending: true }),
  ]);
  const completions = results.filter((r) => r.alreadyCompleted === false);
  assert.strictEqual(completions.length, 1, 'exactly one caller performs the debit');
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000, 'debited exactly once');
  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'completed');

  const rows = await debitRows(rid);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(Number(rows[0].n), 1);
  assert.strictEqual(Number(rows[0].total), 2000);
});

// ── 13. Phase 4D route-level idempotency still intact ────────────────────────
test('13. Phase 4D idempotency regression: replay returns stored response, one debit', async () => {
  h.providerState.reset();
  const balBefore = await walletOf(userIdB);
  const airtime = { network: 'MTN', phone: '08031234567', amount: 2000, pin: '1111' };

  const first = await h.api('POST', '/api/vtu/airtime', { body: airtime, token: tokenB, idempotencyKey: 'LC-4D-KEY' });
  assert.strictEqual(first.status, 200);
  assert.ok(first.data.reference.startsWith('IDP-'), 'idempotency key path used');
  assert.strictEqual(h.providerState.calls, 1);

  h.providerState.calls = 0;
  const replay = await h.api('POST', '/api/vtu/airtime', { body: airtime, token: tokenB, idempotencyKey: 'LC-4D-KEY' });
  assert.strictEqual(replay.status, 200);
  assert.strictEqual(replay.data.reference, first.data.reference);
  assert.strictEqual(h.providerState.calls, 0, 'no provider call on replay');
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000, 'single debit across replay');
});

// ── 14. stale unconfirmed orders auto-expire without any wallet debit ────────
test('14. auto-expire moves stale unconfirmed pending orders to failed, no debit', async () => {
  const rid = orderId('EXPIRY');
  const balBefore = await walletOf(userIdB);
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: false });

  // Backdate the order beyond the expiry window so it is eligible.
  const pool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    await pool.query(
      `UPDATE vtu_orders SET created_at = NOW() - interval '30 minutes' WHERE request_id = $1`,
      [rid]
    );
  } finally {
    await pool.end();
  }

  // Sweep with a zero-minute window so the backdate is definitely stale.
  const result = await db.expireStaleVtuOrders({ olderThanMinutes: 5 });
  assert.strictEqual(result.expired, 1, 'exactly one stale order expired');

  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'failed');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'wallet untouched by auto-expiry');
  const rows = await debitRows(rid);
  assert.strictEqual(rows.length, 1, 'one failed ledger row');
  assert.strictEqual(rows[0].status, 'failed');
});

// ── 15. auto-expiry never touches pending orders with a provider reference ───
test('15. auto-expire skips pending orders that hold a provider order ID', async () => {
  const rid = orderId('KEEP');
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: true });

  const pool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    await pool.query(
      `UPDATE vtu_orders SET created_at = NOW() - interval '30 minutes' WHERE request_id = $1`,
      [rid]
    );
  } finally {
    await pool.end();
  }

  const result = await db.expireStaleVtuOrders({ olderThanMinutes: 5 });
  assert.strictEqual(result.expired, 0, 'reconcilable order is not auto-expired');

  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'pending', 'kept for manual reconciliation');
  assert.ok(order.provider_order_id, 'provider reference intact');
});

// ── 16. long-pending traceable orders get a final resolution ────────────────
test('16. long-pending traceable orders get a final resolution after the reconcile ceiling', async () => {
  const rid = orderId('LONG');
  const balBefore = await walletOf(userIdB);
  await createPendingOrder(rid, userIdB, 3000, { withProviderId: true });

  // Simulate 26 hours of age so it exceeds the 24h long-pending window.
  const pool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    await pool.query(
      `UPDATE vtu_orders SET created_at = NOW() - interval '26 hours' WHERE request_id = $1`,
      [rid]
    );
  } finally {
    await pool.end();
  }

  // Provider never confirms delivery on the final requery → order is failed,
  // wallet untouched (it was never debited while pending).
  h.providerState.reset();
  h.providerState.queryOutcome = 'pending';
  const longPending = await db.getLongPendingVtuOrders({ olderThanHours: 24, limit: 50 });
  assert.ok(longPending.some((r) => r.request_id === rid), 'long-pending order surfaced for final resolution');

  // Re-run the sweep's final-resolution block: one requery (pending) then fail.
  await reconcileVtuOrder(rid);
  assert.ok(h.providerState.queryCalls >= 1, 'provider was requeried one final time');

  // Mark failed as the sweep would (provider never confirmed).
  await db.markVtuOrderFailed(rid, { allowPending: true, failureSuffix: ' — provider never confirmed delivery, not charged' });

  const order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.status, 'failed', 'order failed after final resolution');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'wallet untouched by long-pending resolution');
});

// ── 17. auto-reconcile settles traceable pending orders via the Query API ────
test('17. auto-reconcile settles a pending order once the provider confirms', async () => {
  h.providerState.reset();
  const rid = orderId('AUTOREC');
  const balBefore = await walletOf(userIdB);
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: true });

  // Provider still reports pending on the first sweep → order stays pending,
  // no debit, and attempts are tracked so the next sweep re-checks it.
  h.providerState.queryOutcome = 'pending';
  let list = await db.getReconcilablePendingOrders({ backoffMinutes: 0, maxAttempts: 30 });
  assert.ok(list.some((r) => r.request_id === rid), 'order is reconcilable');
  const result = await reconcileVtuOrder(rid);
  assert.strictEqual(result.outcome, 'pending');
  assert.strictEqual(await walletOf(userIdB), balBefore, 'no debit while still pending');

  // Provider confirms delivery → sweep settles it exactly once.
  h.providerState.queryOutcome = 'success';
  const settled = await reconcileVtuOrder(rid);
  assert.strictEqual(settled.outcome, 'success');
  assert.strictEqual(settled.order.status, 'completed');
  assert.strictEqual(await walletOf(userIdB), balBefore - 2000, 'single debit after auto-confirm');

  // Once terminal it is no longer reconcilable.
  list = await db.getReconcilablePendingOrders({ backoffMinutes: 0, maxAttempts: 30 });
  assert.ok(!list.some((r) => r.request_id === rid), 'terminal order drops out of the sweep set');
});

// ── 17. auto-reconcile respects the attempt budget and backoff window ────────
test('17. auto-reconcile backs off and stops after maxAttempts', async () => {
  h.providerState.reset();
  const rid = orderId('BUDGET');
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: true });

  // Exhaust the attempt budget so the order no longer appears in the sweep set.
  await db.recordReconciliationAttempt(rid);
  await db.recordReconciliationAttempt(rid);
  let list = await db.getReconcilablePendingOrders({ backoffMinutes: 0, maxAttempts: 2 });
  assert.ok(!list.some((r) => r.request_id === rid), 'budget exhausted → not auto-reconciled');

  // A freshly attempted order is skipped until the backoff window elapses.
  const rid2 = orderId('BACKOFF');
  await createPendingOrder(rid2, userIdB, 2000, { withProviderId: true });
  await db.recordReconciliationAttempt(rid2);
  list = await db.getReconcilablePendingOrders({ backoffMinutes: 60, maxAttempts: 30 });
  assert.ok(!list.some((r) => r.request_id === rid2), 'within backoff → not auto-reconciled');

  list = await db.getReconcilablePendingOrders({ backoffMinutes: 0, maxAttempts: 30 });
  assert.ok(list.some((r) => r.request_id === rid2), 'backoff elapsed → reconcilable again');
});

// ── 17b. GET /api/vtu/orders/:requestId resolves pending orders on demand ──
async function ageReconciliation(requestId) {
  const pool = new Pool({ connectionString: h.DATABASE_URL, max: 2 });
  try {
    await pool.query(
      `UPDATE vtu_orders SET last_reconciled_at = NOW() - INTERVAL '1 minute' WHERE request_id = $1`,
      [requestId]
    );
  } finally {
    await pool.end();
  }
}

test('17b. status endpoint fast-reconciles a traceable pending order', async () => {
  h.providerState.reset();
  const rid = orderId('POLLOK');
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: true });

  // Provider still reports pending → endpoint keeps status pending, no debit.
  h.providerState.queryOutcome = 'pending';
  const r1 = await h.api('GET', `/api/vtu/orders/${rid}`, { token: tokenB });
  assert.strictEqual(r1.status, 200);
  assert.strictEqual(r1.data.status, 'pending');
  assert.ok(h.providerState.queryCalls >= 1, 'on-demand query fired');

  // Age the last reconcile so the cooldown passes, then confirm.
  await ageReconciliation(rid);
  h.providerState.queryOutcome = 'success';
  const r2 = await h.api('GET', `/api/vtu/orders/${rid}`, { token: tokenB });
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.data.status, 'completed');
  assert.ok(r2.data.providerOrderId, 'provider order id surfaced');

  // Settled exactly once: wallet debited a single time.
  const settled = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(settled.status, 'completed');
  const debits = await debitRows(rid);
  assert.strictEqual(debits.find(d => d.status === 'completed')?.n || 0, 1);
});

test('17c. status endpoint rejects unknown or foreign orders', async () => {
  h.providerState.reset();
  const rid = orderId('POLL401');
  await createPendingOrder(rid, userIdB, 2000, { withProviderId: true });

  // Unauthenticated.
  const anon = await h.api('GET', `/api/vtu/orders/${rid}`, {});
  assert.strictEqual(anon.status, 401);

  // Different user's order is not exposed.
  const other = await h.api('GET', `/api/vtu/orders/${rid}`, { token: tokenA });
  assert.strictEqual(other.status, 404);

  // Unknown request id.
  const missing = await h.api('GET', '/api/vtu/orders/does-not-exist', { token: tokenB });
  assert.strictEqual(missing.status, 404);
});

// ── 18. scheduled purchases actually execute (wallet debit + provider + schedule) ──
test('18. scheduled purchase executes a real purchase and advances the schedule', async () => {
  assert.ok(scheduledProcessorHooks.processDueScheduledPurchases, 'scheduler hook present');
  h.providerState.reset();
  const balBefore = await walletOf(userIdB);

  // Funded airtime schedule due now.
  const sched = await db.createScheduledPurchase(userIdB, {
    serviceType: 'airtime',
    planCode: null,
    phone: '08136601888',
    identifier: null,
    network: 'MTN',
    amount: 2000,
    frequency: 'daily',
    nextRunAt: new Date(Date.now() - 1000),
  });
  assert.ok(sched.id, 'schedule created');

  await scheduledProcessorHooks.processDueScheduledPurchases();

  const after = await walletOf(userIdB);
  assert.strictEqual(after, balBefore - 2000, 'wallet debited exactly once by scheduled purchase');

  const orders = await db.getVtuOrdersByUser(userIdB, { limit: 20 });
  const mine = orders.filter((o) => o.description === 'airtime — 08136601888');
  assert.ok(mine.length >= 1, 'a real VTU order was created for the schedule');
  assert.ok(mine.some((o) => o.status === 'completed' || o.status === 'pending'), 'order reached a real terminal/pending state');

  // Frequency schedules should have advanced next_run_at; one-off should be disabled.
  const oneOff = await db.createScheduledPurchase(userIdB, {
    serviceType: 'airtime',
    planCode: null,
    phone: '08136601889',
    identifier: null,
    network: 'MTN',
    amount: 1500,
    frequency: 'once',
    nextRunAt: new Date(Date.now() - 1000),
  });
  await scheduledProcessorHooks.processDueScheduledPurchases();

  const reloadedDaily = await db.getScheduledPurchaseById(userIdB, sched.id);
  assert.ok(new Date(reloadedDaily.next_run_at) > new Date(), 'daily schedule advanced');
  const reloadedOnce = await db.getScheduledPurchaseById(userIdB, oneOff.id);
  assert.strictEqual(reloadedOnce.active, false, 'once schedule disabled after running');
  assert.ok(reloadedOnce.run_count >= 1, 'run_count incremented');
});

test('18b. concurrent scheduled sweeps debit and fulfil one occurrence exactly once', async () => {
  h.providerState.reset();
  const balBefore = await walletOf(userIdB);
  const phone = '08136601999';
  const sched = await db.createScheduledPurchase(userIdB, {
    serviceType: 'airtime', planCode: null, phone, identifier: null,
    network: 'MTN', amount: 1000, frequency: 'daily',
    nextRunAt: new Date(Date.now() - 1000),
  });

  await Promise.all([
    scheduledProcessorHooks.processDueScheduledPurchases(),
    scheduledProcessorHooks.processDueScheduledPurchases(),
  ]);

  assert.strictEqual(await walletOf(userIdB), balBefore - 1000, 'wallet debited exactly once');
  const orders = await db.getVtuOrdersByUser(userIdB, { limit: 50 });
  assert.strictEqual(orders.filter((o) => o.description === `airtime — ${phone}`).length, 1, 'one provider order created');
  const reloaded = await db.getScheduledPurchaseById(userIdB, sched.id);
  assert.strictEqual(reloaded.run_count, 1, 'occurrence recorded once');
});

// ── 20. auto-recharge initiates a Paystack session, emails the link ─────────
test('20. auto-recharge emails a top-up link and marks the trigger', async () => {
  assert.ok(scheduledProcessorHooks.processDueAutoRecharges, 'auto-recharge hook present');
  h.autoRechargeState.reset();
  h.emailState.reset();
  const lowUser = userIdC;  // zero-balance user — definitely below any threshold
  await db.setAutoRecharge(lowUser, { threshold: 500, amount: 2000 });

  await scheduledProcessorHooks.processDueAutoRecharges();

  assert.strictEqual(h.autoRechargeState.initializeCalls.length, 1, 'Paystack initialize called once');
  const init = h.autoRechargeState.initializeCalls[0];
  assert.strictEqual(init.url, 'https://api.paystack.co/transaction/initialize');
  assert.strictEqual(init.body.amount, 200000, 'amount sent in kobo');
  assert.strictEqual(init.body.metadata.user_id, lowUser, 'user attached to metadata');
  assert.strictEqual(init.body.metadata.auto_recharge, true, 'marked as auto-recharge');
  assert.ok(init.body.reference.startsWith('AR-'), 'reference uses AR- prefix');

  assert.strictEqual(h.emailState.autoRechargeCalls.length, 1, 'top-up link emailed to the user');
  const emailArgs = h.emailState.autoRechargeCalls[0];
  assert.strictEqual(emailArgs[0], 'lcchidi' + process.pid + '@example.com', 'link goes to the right address');
  const info = emailArgs[2];
  assert.ok(String(info.authorizationUrl).includes('checkout.paystack.com'), 'link points at checkout');

  // In-app fallback: a pending session must exist and be fetchable for the user.
  const pending = await db.getPendingAutoRechargeSession(lowUser);
  assert.ok(pending, 'pending auto-recharge session persisted for the user');
  assert.ok(pending.reference.startsWith('AR-'), 'session carries the AR- reference');
  assert.ok(pending.authorization_url.includes('checkout.paystack.com'), 'session carries the checkout link');
  assert.strictEqual(Number(pending.amount), 2000, 'session carries the top-up amount');

  // Completion clears the session (reflects the webhook credited path).
  await db.completeAutoRechargeSession(pending.reference);
  assert.strictEqual(await db.getPendingAutoRechargeSession(lowUser), null, 'session cleared once paid');

  // Cooldown recorded → a second sweep must NOT create another session.
  await scheduledProcessorHooks.processDueAutoRecharges();
  assert.strictEqual(h.autoRechargeState.initializeCalls.length, 1, 'no re-trigger within cooldown');

  await db.deleteAutoRecharge(lowUser);
});
test('19. scheduled purchase without balance is skipped, schedule kept intact', async () => {
  h.providerState.reset();
  const sched = await db.createScheduledPurchase(userIdC, {
    serviceType: 'airtime',
    planCode: null,
    phone: '08136602000',
    identifier: null,
    network: 'MTN',
    amount: 20000,
    frequency: 'weekly',
    nextRunAt: new Date(Date.now() - 1000),
  });

  await scheduledProcessorHooks.processDueScheduledPurchases();

  const row = await db.getScheduledPurchaseById(userIdC, sched.id);
  assert.strictEqual(row.active, true, 'still active after insufficient-balance skip');
  assert.strictEqual(row.run_count, 0, 'no run counted for a skipped schedule');
  assert.strictEqual(await walletOf(userIdC), 0, 'zero-balance user never debited');
});

// ── 21. provider-reference backfill rescues previously-untraceable orders ──
test('21. backfill recovers provider reference from stored raw response', async () => {
  h.providerState.reset();
  const rid = orderId('RESCUE');
  await db.createVtuAttempt({
    requestId: rid,
    userId: userIdB,
    serviceType: 'airtime',
    amount: 2000,
    description: `Lifecycle rescue ${rid}`,
  });

  // Simulate the pre-fix normaliser: response stored raw with ordernumber but
  // provider_order_id left NULL (exactly how legitimate orders went stale).
  await db.recordVtuProviderResponse(rid, {
    orderId: null,
    statusCode: 199,
    status: 'ORDER_RECEIVED',
    remark: 'On hold',
    description: 'Pending provider confirmation',
    raw: { ordernumber: `NB-RESCUE-${rid}`, statuscode: 199, status: 'ORDER_RECEIVED' },
  });
  await db.markVtuOrderPending(rid);

  let order = await db.getVtuOrderByRequestId(rid);
  assert.strictEqual(order.provider_order_id, null, 'pre-fix order has no provider ref');

  const backfilled = await db.backfillVtuOrderProviderIds({ limit: 50 });
  assert.ok(backfilled.recovered >= 1, 'backfill recovered the orphan');
  const rescued = backfilled.recovered;
  assert.ok(rescued >= 1, `expected >= 1 recovered, got ${rescued}`);

  order = await db.getVtuOrderByRequestId(rid);
  if (order.provider_order_id === null || order.provider_order_id === '') {
    // The specific test order was not in the first scan batch (other tests'
    // pending orders may outrank it in created_at ordering). Run once more to
    // confirm it eventually recovers rather than asserting a flaky scan batch.
    await db.backfillVtuOrderProviderIds({ limit: 500 });
    order = await db.getVtuOrderByRequestId(rid);
  }
  assert.strictEqual(order.provider_order_id, `NB-RESCUE-${rid}`, 'provider ref recovered from raw');
  assert.strictEqual(order.status, 'pending', 'still pending, now traceable for reconcile');
});

test('21b. backfill rejects placeholder references and leaves order intractable', async () => {
  const rid = orderId('RESCUE-PH');
  await db.createVtuAttempt({
    requestId: rid,
    userId: userIdB,
    serviceType: 'airtime',
    amount: 2000,
    description: `Lifecycle rescue placeholder ${rid}`,
  });
  await db.recordVtuProviderResponse(rid, {
    orderId: null,
    statusCode: 199,
    status: 'ORDER_RECEIVED',
    remark: 'On hold',
    description: 'Pending provider confirmation',
    raw: { ordernumber: '0', statuscode: 199, status: 'ORDER_RECEIVED' },
  });
  await db.markVtuOrderPending(rid);

  await db.backfillVtuOrderProviderIds({ limit: 500 });
  const order = await db.getVtuOrderByRequestId(rid);
  assert.ok(!order.provider_order_id, 'placeholder reference never stored');
});
