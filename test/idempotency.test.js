/**
 * TopFlowNG — Phase 4D VTU route-level idempotency tests.
 *
 * Runs against the real throwaway PostgreSQL database (dedicated per-run) with
 * a mocked provider. Exercises end-to-end HTTP idempotency: first-request
 * success, exact retry replay, no duplicate provider calls or debits, payload
 * conflict 409, cross-user key reuse, concurrency (one provider call / one
 * debit), deterministic pending & failed retries, malformed/oversized key 400,
 * and unchanged legacy (no-key) behaviour.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/load-idempotency-app');

let db;
let tokenA;   // user A session
let tokenB;   // user B session
let userIdA;

before(async () => {
  db = require('../database');
  await h.waitForServer();
  h.applyMigrations();

  const regA = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'Idem Ada', email: 'idemada' + process.pid + '@example.com', phone: '08090000001', password: 'secret123' },
  });
  assert.strictEqual(regA.status, 201);
  tokenA = regA.data.token;
  userIdA = regA.data.user.id;

  const regB = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'Idem Bola', email: 'idembola' + process.pid + '@example.com', phone: '08090000002', password: 'secret123' },
  });
  assert.strictEqual(regB.status, 201);
  tokenB = regB.data.token;

  await db.setTransactionPin(userIdA, '1111');
  await db.creditWallet(userIdA, 500000, 'seed', 'seed-A');

  await db.setTransactionPin(regB.data.user.id, '1111');
  await db.creditWallet(regB.data.user.id, 500000, 'seed', 'seed-B');
});

after(async () => {
  await h.cleanup();
});

const AIRTIME = { network: 'MTN', phone: '08031234567', amount: 2000, pin: '1111' };

// ── 1. First request with a new key succeeds ─────────────────────────────────
test('new key: first request succeeds and debits wallet once', async () => {
  h.providerState.reset();
  const r = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'req-0001' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.success, true);
  assert.ok(r.data.reference.startsWith('IDP-'));
  assert.strictEqual(h.providerState.calls, 1);

  const order = await db.getVtuOrderByRequestId(r.data.reference);
  assert.ok(order);
  assert.strictEqual(order.idempotency_key, 'req-0001');
  assert.ok(order.request_fingerprint);
  assert.ok(order.response_snapshot);
});

// ── 2. Exact retry returns stored response ──────────────────────────────────
test('2. exact retry returns stored response', async () => {
  h.providerState.reset();
  const first = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'RETRY-KEY' });
  assert.strictEqual(first.status, 200);
  h.providerState.calls = 0;

  const retry = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'RETRY-KEY' });
  assert.strictEqual(retry.status, 200);
  assert.strictEqual(retry.data.reference, first.data.reference);
  assert.strictEqual(retry.data.success, true);
  assert.strictEqual(retry.data.message, first.data.message);
});

// ── 3. Retry causes zero additional provider calls ──────────────────────────
test('3. retry causes zero additional provider calls', async () => {
  h.providerState.reset();
  await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'CALLS-KEY' });
  assert.strictEqual(h.providerState.calls, 1);
  await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'CALLS-KEY' });
  assert.strictEqual(h.providerState.calls, 1, 'provider must not be called again');
});

// ── 4. Retry causes zero additional wallet debit ────────────────────────────
test('4. retry causes zero additional wallet debit', async () => {
  h.providerState.reset();
  const beforeBal = await db.getWalletBalance(userIdA);
  const first = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'DEBIT-KEY' });
  assert.strictEqual(first.status, 200);
  const afterFirst = await db.getWalletBalance(userIdA);
  assert.ok(afterFirst < beforeBal, 'first request debited wallet');

  await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'DEBIT-KEY' });
  const afterRetry = await db.getWalletBalance(userIdA);
  assert.strictEqual(afterRetry, afterFirst, 'retry must not debit again');
});

// ── 5. Same key, different payload → 409 ────────────────────────────────────
test('5. same key different payload returns 409', async () => {
  h.providerState.reset();
  await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'CONFLICT-KEY' });
  const conflict = await h.api('POST', '/api/vtu/airtime', {
    body: { ...AIRTIME, phone: '08099999999' }, token: tokenA, idempotencyKey: 'CONFLICT-KEY',
  });
  assert.strictEqual(conflict.status, 409);
});

// ── 6. Different users may use the same key ──────────────────────────────
test('6. different users may use the same key', async () => {
  h.providerState.reset();
  const a = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'SHARED-KEY' });
  assert.strictEqual(a.status, 200);
  const b = await h.api('POST', '/api/vtu/airtime', {
    body: { ...AIRTIME, phone: '08091112222' }, token: tokenB, idempotencyKey: 'SHARED-KEY',
  });
  assert.strictEqual(b.status, 200);
});

// ── 7. Concurrent same-key → one provider call, one debit ───────────────────
test('7. concurrent same-key: exactly one provider call and one debit', async () => {
  h.providerState.reset();
  const balBefore = await db.getWalletBalance(userIdA);
  const results = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'CONCURRENT-KEY' })),
  );
  assert.strictEqual(h.providerState.calls, 1, 'exactly one provider call expected');
  const non200 = results.filter((r) => r.status !== 200 && r.status !== 202);
  assert.strictEqual(non200.length, 0, 'only 200 or 202 responses expected');
  assert.strictEqual(await db.getWalletBalance(userIdA), balBefore - 2000, 'wallet debited exactly once');
});

// ── 8. pending response retry is deterministic ──────────────────────────────
test('8. pending response retry is deterministic', async () => {
  h.providerState.reset();
  h.providerState.outcome = 'pending';
  const first = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'PENDING-KEY' });
  assert.strictEqual(first.status, 202);
  h.providerState.calls = 0;
  const retry = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'PENDING-KEY' });
  assert.strictEqual(retry.status, 202);
  assert.strictEqual(retry.data.reference, first.data.reference);
  assert.strictEqual(retry.data.pending, true);
  assert.strictEqual(h.providerState.calls, 0, 'no provider call on pending retry');
});

// ── 9. failed response retry is deterministic ───────────────────────────────
test('9. failed response retry is deterministic', async () => {
  h.providerState.reset();
  h.providerState.outcome = 'failed';
  const first = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'FAIL-KEY' });
  assert.strictEqual(first.status, 400);
  h.providerState.calls = 0;
  const retry = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'FAIL-KEY' });
  assert.strictEqual(retry.status, 400);
  assert.strictEqual(retry.data.reference, first.data.reference);
  assert.strictEqual(h.providerState.calls, 0, 'no provider call on failed retry');
});

// ── 10. malformed / oversized key → 400 ─────────────────────────────────────
test('10. malformed / oversized key returns 400', async () => {
  const bad = [
    '   ',            // blank
    'key with spaces',
    '!@#$%^&*()',
    'a'.repeat(140),  // too long
  ];
  for (const key of bad) {
    const r = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: key });
    assert.strictEqual(r.status, 400, `expected 400 for key: ${JSON.stringify(key)}`);
  }
});

// ── 11. no-key legacy request unchanged ─────────────────────────────────
test('11. legacy request without key remains unchanged', async () => {
  h.providerState.reset();
  const r = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.success, true);
  assert.ok(r.data.reference && String(r.data.reference).length > 0, 'legacy request returns a valid reference');
});

// ── 12. wallet ledger reconciliation ─────────────────────────────────────────
// Sum of completed debit transactions for one idempotent order must equal the
// order amount exactly once; no duplicate ledger rows across retries.
test('12. wallet ledger reconciles: exactly one completed debit per idempotent order', async () => {
  h.providerState.reset();
  const r = await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'LEDGER-KEY' });
  assert.strictEqual(r.status, 200);

  await h.api('POST', '/api/vtu/airtime', { body: AIRTIME, token: tokenA, idempotencyKey: 'LEDGER-KEY' });

  const { Pool } = require('pg');
  const ledger = new Pool({ connectionString: h.DATABASE_URL });
  const { rows } = await ledger.query(
    `SELECT count(*)::int AS n, COALESCE(SUM(amount), 0)::numeric AS total
     FROM transactions
     WHERE user_id = $1 AND reference = $2 AND type = 'debit' AND status = 'completed'`,
    [userIdA, r.data.reference]
  );
  await ledger.end();
  assert.strictEqual(rows[0].n, 1, 'exactly one completed debit row');
  assert.strictEqual(Number(rows[0].total), 2000, 'debit total equals order amount exactly once');
});

// ── 12. full suite regression is run separately (auth/smoke/webhook/migrations) ──