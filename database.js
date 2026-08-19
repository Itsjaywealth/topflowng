'use strict';

/**
 * TopFlowNG — PostgreSQL Database Layer
 * Tables: users, transactions, password_resets, paystack_refs, vtu_orders
 */

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { assertCanTransition } = require('./services/order-lifecycle.js');
const { connectionSslOptions } = require('./lib/dbconn');

const POOL_MAX = parseInt(process.env.PG_POOL_MAX || '15', 10);
const POOL_IDLE_MS = parseInt(process.env.PG_POOL_IDLE_MS || '30000', 10);
const POOL_CONNECT_MS = parseInt(process.env.PG_POOL_CONNECT_MS || '5000', 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: connectionSslOptions(
    process.env.DATABASE_URL,
    process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  ),
  max: Math.min(POOL_MAX, 25),
  idleTimeoutMillis: POOL_IDLE_MS,
  connectionTimeoutMillis: POOL_CONNECT_MS,
});

const SALT_ROUNDS = 12;

// ── Schema Init ───────────────────────────────────────────────────────────────
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id          SERIAL PRIMARY KEY,
        full_name   TEXT NOT NULL,
        email       TEXT UNIQUE NOT NULL,
        phone       TEXT UNIQUE NOT NULL,
        password    TEXT NOT NULL,
        wallet      NUMERIC(12,2) NOT NULL DEFAULT 0,
        is_admin    BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS transactions (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL CHECK (type IN ('credit','debit')),
        amount      NUMERIC(12,2) NOT NULL,
        description TEXT NOT NULL,
        reference   TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_resets (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token       TEXT UNIQUE NOT NULL,
        expires_at  TIMESTAMPTZ NOT NULL,
        used        BOOLEAN NOT NULL DEFAULT false,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS paystack_refs (
        id          SERIAL PRIMARY KEY,
        reference   TEXT UNIQUE NOT NULL,
        user_id     INTEGER NOT NULL,
        amount      NUMERIC(12,2) NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS vtu_orders (
        id                    BIGSERIAL PRIMARY KEY,
        request_id            TEXT UNIQUE NOT NULL,
        user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        service_type          TEXT NOT NULL,
        amount                NUMERIC(12,2) NOT NULL,
        description           TEXT NOT NULL,
        provider_order_id     TEXT,
        provider_status_code  INTEGER,
        provider_status       TEXT,
        provider_remark       TEXT,
        provider_description  TEXT,
        provider_response     JSONB,
        status                TEXT NOT NULL DEFAULT 'submitted'
                              CHECK (status IN ('submitted', 'pending', 'completed', 'failed')),
        transaction_id        INTEGER REFERENCES transactions(id),
        created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
      CREATE INDEX IF NOT EXISTS idx_vtu_orders_user_id ON vtu_orders(user_id);
      CREATE INDEX IF NOT EXISTS idx_vtu_orders_provider_order_id ON vtu_orders(provider_order_id);
      CREATE INDEX IF NOT EXISTS idx_vtu_orders_status ON vtu_orders(status);
    `);

    // Add is_admin column if it doesn't exist (migration safety)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    `).catch(() => {});

    // Existing production databases may predate the transaction reference field.
    await client.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS reference TEXT;
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed';
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS provider_order_id TEXT;
    `);

    // Older production databases used `ref` and did not include an id column.
    // Normalize that legacy idempotency table before webhook queries run.
    await client.query(`
      DO $$
      BEGIN
        IF EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'paystack_refs'
            AND column_name = 'ref'
        ) AND NOT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'paystack_refs'
            AND column_name = 'reference'
        ) THEN
          ALTER TABLE paystack_refs RENAME COLUMN ref TO reference;
        END IF;
      END $$;
    `);
    await client.query(`
      ALTER TABLE paystack_refs ADD COLUMN IF NOT EXISTS id BIGSERIAL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_paystack_refs_reference
        ON paystack_refs(reference);
    `);

    // New feature migrations
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS transaction_pin TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
    `);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_referral_code ON users(referral_code)
      WHERE referral_code IS NOT NULL;
    `).catch(() => {});

    // Supports the referral count (users.referred_by) without a table scan.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_users_referred_by ON users(referred_by)
      WHERE referred_by IS NOT NULL;
    `).catch(() => {});

    await client.query(`
      CREATE TABLE IF NOT EXISTS beneficiaries (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        type        TEXT NOT NULL,
        label       TEXT NOT NULL,
        network     TEXT,
        identifier  TEXT NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_beneficiaries_user_id ON beneficiaries(user_id);
    `);

    await client.query(`
      ALTER TABLE scheduled_purchases
        ADD COLUMN IF NOT EXISTS in_flight_reference TEXT,
        ADD COLUMN IF NOT EXISTS in_flight_for TIMESTAMPTZ;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_in_flight_reference
        ON scheduled_purchases (in_flight_reference)
        WHERE in_flight_reference IS NOT NULL;
    `).catch(() => {});

    console.log('Database schema ready');
  } finally {
    client.release();
  }
}

// Close the connection pool. Used by automated tests so process exits cleanly.
async function closePool() {
  await pool.end();
}

// Lightweight connectivity probe for liveness/readiness. Returns { ok: boolean }
// and never leaks the connection string or credentials to callers.
async function ping() {
  try {
    await pool.query('SELECT 1');
    return { ok: true };
  } catch (err) {
    return { ok: false };
  }
}

// ── User Queries ──────────────────────────────────────────────────────────────
async function findUserByEmail(email) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE LOWER(email) = LOWER($1) LIMIT 1',
    [email]
  );
  return rows[0] || null;
}

async function findUserByPhone(phone) {
  const { rows } = await pool.query(
    'SELECT * FROM users WHERE phone = $1 LIMIT 1',
    [phone]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, full_name, email, phone, wallet, is_admin, created_at FROM users WHERE id = $1 LIMIT 1',
    [id]
  );
  return rows[0] || null;
}

async function createUser({ fullName, email, phone, password, referredBy = null }) {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, phone, password, referred_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, full_name, email, phone, wallet, is_admin`,
    [fullName, email, phone, hash, referredBy || null]
  );
  return rows[0];
}

async function findUserByReferralCode(code) {
  const { rows } = await pool.query(
    'SELECT id FROM users WHERE referral_code = $1 LIMIT 1',
    [code]
  );
  return rows[0] || null;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password);
}

async function updateUserPassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, userId]);
}

// ── Wallet ────────────────────────────────────────────────────────────────────
async function getWalletBalance(userId) {
  const { rows } = await pool.query(
    'SELECT wallet FROM users WHERE id = $1',
    [userId]
  );
  return parseFloat(rows[0]?.wallet || 0);
}

async function creditWallet(userId, amount, description, reference = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE users SET wallet = wallet + $1 WHERE id = $2 RETURNING wallet',
      [amount, userId]
    );
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, reference)
       VALUES ($1, 'credit', $2, $3, $4)`,
      [userId, amount, description, reference]
    );
    await client.query('COMMIT');
    return parseFloat(rows[0].wallet);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function debitWallet(userId, amount, description, reference = null) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users SET wallet = wallet - $1
       WHERE id = $2 AND wallet >= $1
       RETURNING wallet`,
      [amount, userId]
    );
    if (rows.length === 0) throw new Error('Insufficient balance');
    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, reference)
       VALUES ($1, 'debit', $2, $3, $4)`,
      [userId, amount, description, reference]
    );
    await client.query('COMMIT');
    return parseFloat(rows[0].wallet);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function getTransactions(userId, { limit = 20, offset = 0, q = null, category = null, status = null, from = null, to = null } = {}) {
  const params = [userId];
  let sql = `SELECT id, type, amount, description, reference, status, provider_order_id, created_at
             FROM transactions WHERE user_id = $1`;
  if (category && category !== 'all' && category !== 'credit') {
    params.push(category);
    sql += ` AND ${categoryFilterClause(category, '$' + params.length)}`;
  } else if (category === 'credit') {
    sql += ` AND type = 'credit'`;
  }
  if (status && status !== 'all') {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  if (from) { params.push(from); sql += ` AND created_at >= $${params.length}`; }
  if (to) { params.push(to); sql += ` AND created_at < $${params.length}`; }
  if (q) {
    params.push(`%${q}%`);
    sql += ` AND (description ILIKE $${params.length} OR reference ILIKE $${params.length} OR provider_order_id ILIKE $${params.length})`;
  }
  const countRes = await pool.query(
    `SELECT COUNT(*) AS total FROM (${sql}) t`, params
  );
  const base = params.length + 1;
  params.push(limit, offset);
  sql += ' ORDER BY created_at DESC LIMIT $' + base + ' OFFSET $' + (base + 1);
  const { rows } = await pool.query(sql, params);
  return { transactions: rows, total: parseInt(countRes.rows[0].total, 10) };
}

function categoryFilterClause(category, placeholder) {
  switch (category) {
    case 'airtime': return `(description ILIKE 'Airtime%' OR description ILIKE '% airtime %')`;
    case 'data': return `(description ILIKE 'Data%' OR description ILIKE '% data %' OR description ILIKE '%Bundle%')`;
    case 'electricity': return `(description ILIKE 'Electricity%' OR description ILIKE '%Electricity%' OR description ILIKE '% prepaid %' OR description ILIKE '% postpaid %')`;
    case 'cable': return `(description ILIKE '%DStv%' OR description ILIKE '%GOtv%' OR description ILIKE '%StarTimes%' OR description ILIKE '% cable %' OR description ILIKE 'Cable%')`;
    case 'exam-pin': return `(description ILIKE 'Exam%' OR description ILIKE '%WAEC%' OR description ILIKE '%NECO%' OR description ILIKE '%NABTEB%' OR description ILIKE '%JAMB%')`;
    case 'recharge-pin': return `(description ILIKE '%Recharge%' OR description ILIKE '% card pin %')`;
    case 'wallet': return `(type = 'credit' OR type = 'debit')`;
    default: return 'TRUE';
  }
}

async function logFailedTransaction(userId, description, amount) {
  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description, reference, status)
     VALUES ($1, 'debit', $2, $3, 'FAILED', 'failed')`,
    [userId, amount, description]
  ).catch(err => console.error('Failed to log failed transaction:', err.message));
}

// ── Clubkonnect VTU reconciliation ─────────────────────────────────────────
// The provider can acknowledge an order before the mobile network has decided
// its outcome. We therefore keep the provider's order ID and response separate
// from wallet movement, so uncertain orders never debit a customer.
async function createVtuAttempt({ requestId, userId, serviceType, amount, description }) {
  const { rows } = await pool.query(
    `INSERT INTO vtu_orders (request_id, user_id, service_type, amount, description)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (request_id) DO UPDATE SET updated_at = NOW()
     RETURNING *`,
    [requestId, userId, serviceType, amount, description]
  );
  return rows[0];
}

// Create an order for the DIRECT payment mode: payment is collected via the
// payment provider (Paystack) for THIS specific order before fulfilment, so the
// order starts as payment_status='pending' with a payment reference attached.
// No stored customer wallet is involved in direct mode.
async function createDirectOrder({ requestId, userId, serviceType, amount, description, paymentReference, requestPayload = null }) {
  const { rows } = await pool.query(
    `INSERT INTO vtu_orders
       (request_id, user_id, service_type, amount, description, payment_reference, payment_status, request_payload)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)
     ON CONFLICT (request_id)
       DO UPDATE SET updated_at = NOW(),
                     payment_reference = COALESCE(vtu_orders.payment_reference, EXCLUDED.payment_reference),
                     payment_status = COALESCE(vtu_orders.payment_status, EXCLUDED.payment_status)
     RETURNING *`,
    [requestId, userId, serviceType, amount, description, paymentReference, requestPayload ? JSON.stringify(requestPayload) : null]
  );
  return rows[0];
}

// Look up a direct order by its payment-provider reference. Used by the
// payment-verification bridge to correlate a verified Paystack payment with the
// exact TopFlowNG order it was created for (one payment → at most one order).
async function findOrderByPaymentReference(paymentReference) {
  const { rows } = await pool.query(
    'SELECT * FROM vtu_orders WHERE payment_reference = $1 ORDER BY id DESC LIMIT 1',
    [paymentReference]
  );
  return rows[0] || null;
}

// Mark a direct order's payment as confirmed (paid) after the payment provider
// authoritatively verifies it. Idempotent: setting paid when already paid is a
// no-op. Never changes users.wallet.
async function markOrderPaid(requestId, paymentReference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM vtu_orders WHERE request_id = $1 FOR UPDATE', [requestId]
    );
    const order = result.rows[0];
    if (!order) throw new Error(`VTU order ${requestId} not found`);
    if (order.payment_status === 'paid') {
      await client.query('COMMIT');
      return order;
    }
    await client.query(
      `UPDATE vtu_orders
       SET payment_status = 'paid', paid_at = NOW(), payment_reference = COALESCE($2, payment_reference),
           updated_at = NOW()
       WHERE id = $1`,
      [order.id, paymentReference]
    );
    await client.query('COMMIT');
    const fresh = await client.query('SELECT * FROM vtu_orders WHERE id = $1', [order.id]);
    return fresh.rows[0];
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function acquireVtuIdempotency({ requestId, userId, serviceType, amount, description, idempotencyKey, requestFingerprint }) {
  // Reserve an idempotency slot on vtu_orders. The same logical slot is
  // covered by TWO unique constraints — request_id AND the partial unique
  // index (user_id, idempotency_key) — so under concurrent same-key requests
  // Postgres may report the violation against either one, and an ON CONFLICT
  // arbiter can only ever match one index (raising 23505 when it hits the
  // other). Instead of suppressing every unique violation, we serialize the
  // claim with a transaction-scoped advisory lock keyed to the request id:
  // only one transaction at a time attempts the INSERT, so the arbiter on
  // request_id is always the one that fires. Rows without a key are exempt;
  // every subsequent/concurrent request for the same key blocks on the lock,
  // observes the committed row, and returns it for the caller to resolve.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [requestId]);
    const inserted = await client.query(
      `INSERT INTO vtu_orders
         (request_id, user_id, service_type, amount, description, idempotency_key,
          request_fingerprint, idempotency_key_created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
       ON CONFLICT (request_id) DO NOTHING
       RETURNING request_id`,
      [requestId, userId, serviceType, amount, description, idempotencyKey, requestFingerprint]
    );
    const claimed = inserted.rows[0] ? true : false;
    let order = null;
    if (!claimed) {
      const existing = await client.query(
        `SELECT request_fingerprint, status, response_snapshot, provider_order_id
         FROM vtu_orders
         WHERE user_id = $1 AND idempotency_key = $2
         FOR UPDATE`,
        [userId, idempotencyKey]
      );
      order = existing.rows[0] || null;
    }
    await client.query('COMMIT');
    return { claimed, order: order || null };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recordVtuIdempotencyResult(requestId, response) {
  await pool.query(
    `UPDATE vtu_orders
     SET response_snapshot = $2::jsonb,
         idempotency_key_last_used_at = NOW()
     WHERE request_id = $1`,
    [requestId, JSON.stringify(response)]
  );
}

async function recordVtuProviderResponse(requestId, provider) {
  const raw = (provider.raw && typeof provider.raw === 'object') ? { ...provider.raw } : {};
  // Durably persist any vended token / PIN so it survives the success modal and
  // can be recovered from transaction detail, the receipt, or admin tools.
  if (provider.token) raw.token = provider.token;
  if (provider.purchasedCode) raw.purchasedCode = provider.purchasedCode;
  const { rows } = await pool.query(
    `UPDATE vtu_orders
     SET provider_order_id = COALESCE($2, provider_order_id),
         provider_status_code = $3,
         provider_status = $4,
         provider_remark = $5,
         provider_description = $6,
         provider_response = $7::jsonb,
         updated_at = NOW()
     WHERE request_id = $1
     RETURNING *`,
    [
      requestId,
      provider.orderId || null,
      provider.statusCode ?? null,
      provider.status || null,
      provider.remark || null,
      provider.description || null,
      JSON.stringify(raw),
    ]
  );
  return rows[0] || null;
}

async function recordReconciliationAttempt(requestId) {
  await pool.query(
    `UPDATE vtu_orders
     SET reconcile_attempts = reconcile_attempts + 1,
         last_reconciled_at = NOW()
     WHERE request_id = $1`,
    [requestId]
  );
}

async function completeVtuOrder(requestId, { allowPending = false } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM vtu_orders WHERE request_id = $1 FOR UPDATE', [requestId]
    );
    const order = result.rows[0];
    if (!order) throw new Error(`VTU order ${requestId} not found`);
    if (order.status === 'completed') {
      const balance = await client.query('SELECT wallet FROM users WHERE id = $1', [order.user_id]);
      await client.query('COMMIT');
      return { alreadyCompleted: true, balance: parseFloat(balance.rows[0].wallet), order };
    }
    assertCanTransition(order.status, 'completed');
    if (order.status === 'pending' && !allowPending) throw new Error(`VTU order ${requestId} is pending reconciliation`);

    const wallet = await client.query(
      'UPDATE users SET wallet = wallet - $1 WHERE id = $2 AND wallet >= $1 RETURNING wallet',
      [order.amount, order.user_id]
    );
    if (!wallet.rows.length) throw new Error('Insufficient balance to settle confirmed provider order');

    let transactionId = order.transaction_id;
    if (transactionId) {
      await client.query(
        `UPDATE transactions
         SET status = 'completed',
             description = regexp_replace(description, ' — pending provider confirmation$', ''),
             provider_order_id = COALESCE($2, provider_order_id)
         WHERE id = $1`,
        [transactionId, order.provider_order_id]
      );
    } else {
      const txn = await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, reference, status, provider_order_id)
         VALUES ($1, 'debit', $2, $3, $4, 'completed', $5)
         RETURNING id`,
        [order.user_id, order.amount, order.description, order.request_id, order.provider_order_id]
      );
      transactionId = txn.rows[0].id;
    }
    await client.query(
      `UPDATE vtu_orders SET status = 'completed', transaction_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [order.id, transactionId]
    );
    await client.query('COMMIT');
    return { alreadyCompleted: false, balance: parseFloat(wallet.rows[0].wallet), order };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markVtuOrderPending(requestId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const orderResult = await client.query(
      'SELECT * FROM vtu_orders WHERE request_id = $1 FOR UPDATE', [requestId]
    );
    const order = orderResult.rows[0];
    if (!order) throw new Error(`VTU order ${requestId} not found`);
    assertCanTransition(order.status, 'pending');
    if (order.status === 'pending') {
      await client.query('COMMIT');
      return order;
    }
    let transactionId = order.transaction_id;
    if (!transactionId) {
      const transactionResult = await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, reference, status, provider_order_id)
         VALUES ($1, 'debit', $2, $3, $4, 'pending', $5)
         RETURNING id`,
        [order.user_id, order.amount, `${order.description} — pending provider confirmation`, order.request_id, order.provider_order_id]
      );
      transactionId = transactionResult.rows[0].id;
    }
    await client.query(
      `UPDATE vtu_orders SET status = 'pending', transaction_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [order.id, transactionId]
    );
    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function markVtuOrderFailed(requestId, { allowPending = false, failureSuffix = ' — provider declined' } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM vtu_orders WHERE request_id = $1 FOR UPDATE', [requestId]
    );
    const order = result.rows[0];
    if (!order) throw new Error(`VTU order ${requestId} not found`);
    if (order.status !== 'failed' && order.status !== 'pending') assertCanTransition(order.status, 'failed', 409);
    if (order.status === 'pending' && !allowPending) {
      await client.query('COMMIT');
      return order;
    }
    if (order.status === 'failed') {
      await client.query('COMMIT');
      return order;
    }
    let transactionId = order.transaction_id;
    if (transactionId) {
      await client.query(
        `UPDATE transactions
         SET status = 'failed',
             description = regexp_replace(description, ' — pending provider confirmation$', $2)
         WHERE id = $1`,
        [transactionId, failureSuffix]
      );
    } else {
      const txn = await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, reference, status, provider_order_id)
         VALUES ($1, 'debit', $2, $3, $4, 'failed', $5)
         RETURNING id`,
        [order.user_id, order.amount, `Failed ${order.description}`, order.request_id, order.provider_order_id]
      );
      transactionId = txn.rows[0].id;
    }
    await client.query(
      `UPDATE vtu_orders SET status = 'failed', transaction_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [order.id, transactionId]
    );
    await client.query('COMMIT');
    return order;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Complete a vtu_orders row as paid-and-fulfilled WITHOUT debiting the stored
// customer wallet. Used by the DIRECT payment mode, where the customer already
// paid the payment provider (Paystack) for this specific order before VTPass
// fulfilment. A transaction is still recorded for accounting, but `users.wallet`
// is left untouched — the customer has no stored-value balance in direct mode.
async function completeDirectOrder(requestId, { paymentReference = null } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      'SELECT * FROM vtu_orders WHERE request_id = $1 FOR UPDATE', [requestId]
    );
    const order = result.rows[0];
    if (!order) throw new Error(`VTU order ${requestId} not found`);
    if (order.status === 'completed') {
      await client.query('COMMIT');
      return { alreadyCompleted: true, order };
    }
    assertCanTransition(order.status, 'completed');

    let transactionId = order.transaction_id;
    if (transactionId) {
      await client.query(
        `UPDATE transactions
         SET status = 'completed',
             description = regexp_replace(description, ' — pending provider confirmation$', ''),
             provider_order_id = COALESCE($2, provider_order_id)
         WHERE id = $1`,
        [transactionId, order.provider_order_id]
      );
    } else {
      const txn = await client.query(
        `INSERT INTO transactions (user_id, type, amount, description, reference, status, provider_order_id)
         VALUES ($1, 'debit', $2, $3, $4, 'completed', $5)
         RETURNING id`,
        [order.user_id, order.amount, order.description, order.request_id, order.provider_order_id]
      );
      transactionId = txn.rows[0].id;
    }
    await client.query(
      `UPDATE vtu_orders
       SET status = 'completed', transaction_id = $2, updated_at = NOW(),
           payment_status = COALESCE($3, payment_status)
       WHERE id = $1`,
      [order.id, transactionId, paymentReference ? 'paid' : null]
    );
    await client.query('COMMIT');
    return { alreadyCompleted: false, order };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function promoteToAdmin(userId) {
  await pool.query('UPDATE users SET is_admin = TRUE WHERE id = $1', [userId]);
}

async function getVtuOrderByRequestId(requestId) {
  const { rows } = await pool.query(
    `SELECT request_id, user_id, service_type, amount, description, provider_order_id,
            provider_status_code, provider_status, provider_remark, provider_description,
            status, transaction_id, created_at, updated_at,
            idempotency_key, request_fingerprint, response_snapshot, provider_response,
            idempotency_key_created_at, idempotency_key_last_used_at,
            reconcile_attempts, last_reconciled_at
     FROM vtu_orders WHERE request_id = $1`,
    [requestId]
  );
  return rows[0] || null;
}

// ── Password Reset ────────────────────────────────────────────────────────────
async function createPasswordReset(userId, token) {
  // Invalidate any existing tokens for this user
  await pool.query(
    'UPDATE password_resets SET used = true WHERE user_id = $1 AND used = false',
    [userId]
  );
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  await pool.query(
    `INSERT INTO password_resets (user_id, token, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, token, expiresAt]
  );
}

async function consumePasswordReset(token, newPassword) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM password_resets
       WHERE token = $1 AND used = false AND expires_at > NOW()
       LIMIT 1`,
      [token]
    );
    if (rows.length === 0) throw new Error('Invalid or expired reset token');
    const reset = rows[0];
    const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    await client.query('UPDATE users SET password = $1 WHERE id = $2', [hash, reset.user_id]);
    await client.query('UPDATE password_resets SET used = true WHERE id = $1', [reset.id]);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Paystack Idempotency ──────────────────────────────────────────────────────
async function paystackRefExists(reference) {
  const { rows } = await pool.query(
    'SELECT id FROM paystack_refs WHERE reference = $1 LIMIT 1',
    [reference]
  );
  return rows.length > 0;
}

async function savePaystackRef(reference, userId, amount) {
  await pool.query(
    `INSERT INTO paystack_refs (reference, user_id, amount)
     VALUES ($1, $2, $3) ON CONFLICT (reference) DO NOTHING`,
    [reference, userId, amount]
  );
}

// Atomically claims a Paystack reference and creates its wallet credit. Keeping
// both writes in one transaction prevents webhook/callback races and avoids
// marking a reference processed when the wallet credit fails.
async function creditVerifiedPaystackPayment(reference, userId, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const claim = await client.query(
      `INSERT INTO paystack_refs (reference, user_id, amount)
       VALUES ($1, $2, $3)
       ON CONFLICT (reference) DO NOTHING
       RETURNING reference`,
      [reference, userId, amount]
    );

    if (claim.rows.length === 0) {
      await client.query('COMMIT');
      return { credited: false, balance: await getWalletBalance(userId) };
    }

    const { rows } = await client.query(
      'UPDATE users SET wallet = wallet + $1 WHERE id = $2 RETURNING wallet',
      [amount, userId]
    );
    if (rows.length === 0) throw new Error(`User ${userId} not found for Paystack credit`);

    await client.query(
      `INSERT INTO transactions (user_id, type, amount, description, reference)
       VALUES ($1, 'credit', $2, $3, $4)`,
      [userId, amount, 'Wallet top-up via Paystack', reference]
    );

    // ── Referral bonus on first top-up ───────────────────────────────────────
    // Check if this is the user's first credited top-up and if they were referred.
    const prevCount = await client.query(
      `SELECT COUNT(*) FROM paystack_refs WHERE user_id = $1 AND reference != $2`,
      [userId, reference]
    );
    if (parseInt(prevCount.rows[0].count) === 0) {
      // First top-up — look for a referrer
      const referrerRow = await client.query(
        `SELECT referred_by FROM users WHERE id = $1 AND referred_by IS NOT NULL`,
        [userId]
      );
      if (referrerRow.rows.length > 0) {
        const referrerId = referrerRow.rows[0].referred_by;
        const REFERRAL_BONUS = 100; // ₦100 per referred user's first top-up
        await client.query(
          'UPDATE users SET wallet = wallet + $1 WHERE id = $2',
          [REFERRAL_BONUS, referrerId]
        );
        await client.query(
          `INSERT INTO transactions (user_id, type, amount, description, reference)
           VALUES ($1, 'credit', $2, $3, $4)`,
          [referrerId, REFERRAL_BONUS, `Referral bonus — new user funded`, `REF-${reference}`]
        );
        console.log(`Referral bonus ₦${REFERRAL_BONUS} credited to user ${referrerId} for referring user ${userId}`);
      }
    }

    await client.query('COMMIT');
    return { credited: true, balance: parseFloat(rows[0].wallet) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ── Admin Queries ─────────────────────────────────────────────────────────────
async function getAdminStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users)::int                                 AS total_users,
      (SELECT COUNT(*) FROM transactions)::int                          AS total_transactions,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'credit')  AS total_credited,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'debit'
         AND status = 'completed')                                                 AS total_debited,
      (SELECT COUNT(*) FROM vtu_orders WHERE status IN ('pending','submitted'))  AS pending_orders,
      (SELECT COUNT(*) FROM users WHERE created_at >= CURRENT_DATE)::int        AS new_users_today,
      (SELECT COUNT(*) FROM transactions WHERE created_at >= CURRENT_DATE)::int  AS transactions_today,
      (SELECT COUNT(*) FROM transactions WHERE created_at >= CURRENT_DATE
         AND status = 'completed' AND type = 'debit')::int                       AS completed_today,
      (SELECT COUNT(*) FROM transactions WHERE created_at >= CURRENT_DATE
         AND status = 'failed')::int                                             AS failed_today,
      (SELECT COUNT(*) FROM vtu_orders WHERE created_at >= CURRENT_DATE
         AND status IN ('pending','submitted'))::int                             AS pending_today,
      (SELECT COUNT(*) FROM vtu_orders)::int                            AS vtu_orders_total,
      (SELECT COUNT(*) FROM vtu_orders WHERE status = 'completed')::int AS vtu_completed_total,
      (SELECT COUNT(*) FROM vtu_orders WHERE status = 'failed')::int    AS vtu_failed_total,
      (SELECT COUNT(*) FROM vtu_orders WHERE status IN ('pending','submitted'))::int AS vtu_pending_total
  `);
  const s = rows[0];
  const doneToday = (s.completed_today || 0) + (s.failed_today || 0);
  s.success_rate_today = doneToday > 0 ? Math.round(((s.completed_today || 0) / doneToday) * 1000) / 10 : null;
  const avg = await pool.query(
    `SELECT AVG(amount)::float AS avg_amount FROM transactions
     WHERE created_at >= CURRENT_DATE AND status = 'completed' AND type = 'debit'`
  );
  s.avg_transaction_amount_today = avg.rows[0]?.avg_amount != null ? parseFloat(avg.rows[0].avg_amount) : null;
  // Ops signal: pending orders that have been stuck long enough to warrant a
  // human look (older than the sweep cadence, i.e. not just being processed).
  const stale = await pool.query(
    `SELECT COUNT(*)::int AS n FROM vtu_orders
     WHERE status IN ('pending','submitted')
       AND created_at < NOW() - INTERVAL '30 minutes'`
  );
  s.stale_pending = stale.rows[0].n;
  try {
    const bg = await pool.query(
      `SELECT COUNT(*)::int AS n FROM scheduled_execution_claims WHERE expires_at < NOW()`
    );
    s.expired_claims = bg.rows[0].n;
  } catch {
    s.expired_claims = 0; // table may not exist yet
  }
  return s;
}

async function getAllTransactions({ limit = 50, offset = 0, type, status, q, from, to } = {}) {
  const clauses = [];
  const params = [];
  let idx = 1;
  if (type) { clauses.push(`t.type = $${idx++}`); params.push(type); }
  if (status) { clauses.push(`t.status = $${idx++}`); params.push(status); }
  if (from) { clauses.push(`t.created_at >= $${idx++}`); params.push(from); }
  if (to) { clauses.push(`t.created_at <= $${idx++}`); params.push(to); }
  if (q) {
    clauses.push(`(
      t.description ILIKE $${idx} OR t.reference ILIKE $${idx}
      OR u.full_name ILIKE $${idx} OR u.email ILIKE $${idx}
    )`);
    params.push(`%${q}%`);
    idx++;
  }
  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT t.id, t.type, t.amount, t.description, t.reference, t.status,
                      t.provider_order_id, t.created_at,
                      u.full_name AS user_name, u.email AS user_email
               FROM transactions t
               JOIN users u ON u.id = t.user_id
               ${where}
               ORDER BY t.created_at DESC
               LIMIT $${idx++} OFFSET $${idx++}`;
  const [countResult, rowsResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM transactions t JOIN users u ON u.id = t.user_id ${where}`,
      params
    ),
    pool.query(sql, [...params, limit, offset]),
  ]);
  return { transactions: rowsResult.rows, total: countResult.rows[0].total };
}

async function getAllUsers({ limit = 50, offset = 0, q } = {}) {
  const params = [];
  let idx = 1;
  let where = '';
  if (q) {
    where = `WHERE (
      full_name ILIKE $${idx} OR email ILIKE $${idx} OR phone ILIKE $${idx}
    )`;
    params.push(`%${q}%`);
    idx++;
  }
  const [countResult, rowsResult] = await Promise.all([
    pool.query(`SELECT COUNT(*)::int AS total FROM users ${where}`, params),
    pool.query(
      `SELECT id, full_name, email, phone, wallet, is_admin, created_at
       FROM users ${where} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`,
      [...params, limit, offset]
    ),
  ]);
  return { users: rowsResult.rows, total: countResult.rows[0].total };
}

async function getAdminVtuOrders({ limit = 50, offset = 0, status, q } = {}) {
  const clauses = [];
  const params = [];
  let idx = 1;
  if (status) { clauses.push(`v.status = $${idx++}`); params.push(status); }
  if (q) {
    clauses.push(`(
      v.request_id ILIKE $${idx} OR v.description ILIKE $${idx}
      OR v.provider_order_id ILIKE $${idx} OR u.full_name ILIKE $${idx}
      OR u.email ILIKE $${idx}
    )`);
    params.push(`%${q}%`);
    idx++;
  }
  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT v.request_id, v.service_type, v.amount, v.description,
                      v.provider_order_id, v.status, v.reconcile_attempts,
                      v.last_reconciled_at, v.created_at,
                      u.full_name AS user_name, u.email AS user_email
               FROM vtu_orders v
               JOIN users u ON u.id = v.user_id
               ${where}
               ORDER BY v.created_at DESC
               LIMIT $${idx++} OFFSET $${idx++}`;
  const [countResult, rowsResult] = await Promise.all([
    pool.query(
      `SELECT COUNT(*)::int AS total FROM vtu_orders v JOIN users u ON u.id = v.user_id ${where}`,
      params
    ),
    pool.query(sql, [...params, limit, offset]),
  ]);
  return { orders: rowsResult.rows, total: countResult.rows[0].total };
}

// ── Transaction PIN ───────────────────────────────────────────────────────────
async function setTransactionPin(userId, pin) {
  const hash = await bcrypt.hash(pin, SALT_ROUNDS);
  await pool.query('UPDATE users SET transaction_pin = $1 WHERE id = $2', [hash, userId]);
}

async function verifyTransactionPin(userId, pin) {
  const { rows } = await pool.query('SELECT transaction_pin FROM users WHERE id = $1', [userId]);
  if (!rows[0] || !rows[0].transaction_pin) return false;
  return bcrypt.compare(pin, rows[0].transaction_pin);
}

async function hasTransactionPin(userId) {
  const { rows } = await pool.query('SELECT transaction_pin IS NOT NULL AS has_pin FROM users WHERE id = $1', [userId]);
  return rows[0]?.has_pin || false;
}

// ── Referral ──────────────────────────────────────────────────────────────────
function generateCode(userId) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'TF';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code + userId;
}

async function ensureReferralCode(userId) {
  const { rows } = await pool.query('SELECT referral_code FROM users WHERE id = $1', [userId]);
  if (rows[0]?.referral_code) return rows[0].referral_code;
  let code;
  for (let attempt = 0; attempt < 5; attempt++) {
    code = generateCode(userId);
    try {
      await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, userId]);
      return code;
    } catch { /* duplicate, retry */ }
  }
  throw new Error('Could not generate referral code');
}

/**
 * Referral stats.
 *
 * `totalReferrals` counts users who actually signed up with this user's code
 * (users.referred_by), which is the real, verifiable signal — it used to count
 * "Referral bonus" transactions, which nothing in the platform creates, so it
 * was permanently 0 no matter how many people a user referred.
 *
 * `totalEarned` sums referral-bonus credits. There is no reward-payout engine
 * yet, so this is 0 by design; `rewardsEnabled` tells the UI to present the
 * programme as invite-tracking rather than promising earnings that would never
 * arrive.
 */
async function getReferralStats(userId) {
  const code = await ensureReferralCode(userId);
  const [referred, earned] = await Promise.all([
    pool.query('SELECT COUNT(*) AS total FROM users WHERE referred_by = $1', [userId]),
    pool.query(
      `SELECT COALESCE(SUM(amount),0) AS earned
       FROM transactions WHERE user_id = $1 AND description ILIKE 'Referral bonus%'`,
      [userId]
    ),
  ]);
  return {
    referralCode: code,
    totalReferrals: parseInt(referred.rows[0].total, 10),
    totalEarned: parseFloat(earned.rows[0].earned),
    rewardsEnabled: false,
  };
}

// ── Beneficiaries ─────────────────────────────────────────────────────────────
async function getBeneficiaries(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM beneficiaries WHERE user_id = $1 ORDER BY created_at DESC',
    [userId]
  );
  return rows;
}

async function addBeneficiary(userId, { type, label, network, identifier }) {
  const { rows } = await pool.query(
    `INSERT INTO beneficiaries (user_id, type, label, network, identifier)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, type, label, network || null, identifier]
  );
  return rows[0];
}

async function deleteBeneficiary(userId, beneficiaryId) {
  const { rowCount } = await pool.query(
    'DELETE FROM beneficiaries WHERE id = $1 AND user_id = $2',
    [beneficiaryId, userId]
  );
  return rowCount > 0;
}

// ── Analytics Summary ─────────────────────────────────────────────────────────
async function getAnalyticsSummary(userId) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE description ILIKE 'Airtime%') AS airtime_count,
       COALESCE(SUM(amount) FILTER (WHERE description ILIKE 'Airtime%'),0) AS airtime_total,
       COUNT(*) FILTER (WHERE description ILIKE 'Data%') AS data_count,
       COALESCE(SUM(amount) FILTER (WHERE description ILIKE 'Data%'),0) AS data_total,
       COUNT(*) FILTER (WHERE description ILIKE 'Electricity%') AS electricity_count,
       COALESCE(SUM(amount) FILTER (WHERE description ILIKE 'Electricity%'),0) AS electricity_total,
       COUNT(*) FILTER (WHERE description ILIKE '%cable%' OR description ILIKE 'DStv%' OR description ILIKE 'GOtv%' OR description ILIKE 'StarTimes%') AS cable_count,
       COALESCE(SUM(amount) FILTER (WHERE description ILIKE '%cable%' OR description ILIKE 'DStv%' OR description ILIKE 'GOtv%' OR description ILIKE 'StarTimes%'),0) AS cable_total,
       COUNT(*) FILTER (WHERE description ILIKE 'Exam%' OR description ILIKE 'WAEC%' OR description ILIKE 'NECO%') AS exam_count,
       COALESCE(SUM(amount) FILTER (WHERE description ILIKE 'Exam%' OR description ILIKE 'WAEC%' OR description ILIKE 'NECO%'),0) AS exam_total,
       COUNT(*) FILTER (WHERE type = 'debit') AS total_count,
       COALESCE(SUM(amount) FILTER (WHERE type = 'debit'),0) AS total_spent
     FROM transactions WHERE user_id = $1 AND type = 'debit'`,
    [userId]
  );
  return rows[0];
}

// ── In-app notifications ─────────────────────────────────────────────────────
async function createNotification({ userId, category = 'transaction', title, message, link = null }) {
  const { rows } = await pool.query(
    `INSERT INTO notifications (user_id, category, title, message, link)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, user_id, category, title, message, link, read_at, created_at`,
    [userId, category, title, message, link]
  );
  return rows[0];
}

async function getNotifications(userId, { limit = 30, offset = 0, category = null, unreadOnly = false } = {}) {
  const params = [userId, limit, offset];
  let sql = `SELECT id, category, title, message, link, read_at, created_at
             FROM notifications WHERE user_id = $1`;
  if (category && category !== 'all') { params.push(category); sql += ` AND category = $${params.length}`; }
  if (unreadOnly) { sql += ' AND read_at IS NULL'; }
  sql += ' ORDER BY created_at DESC LIMIT $2 OFFSET $3';
  const { rows } = await pool.query(sql, params);
  const countRes = await pool.query('SELECT COUNT(*) AS total FROM notifications WHERE user_id = $1', [userId]);
  return { notifications: rows, total: parseInt(countRes.rows[0].total, 10) };
}

async function getUnreadNotificationCount(userId) {
  const { rows } = await pool.query(
    'SELECT COUNT(*) AS unread FROM notifications WHERE user_id = $1 AND read_at IS NULL',
    [userId]
  );
  return parseInt(rows[0].unread, 10);
}

async function markNotificationRead(userId, notificationId) {
  const { rows } = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE id = $1 AND user_id = $2
     RETURNING id, read_at`,
    [notificationId, userId]
  );
  return rows[0] || null;
}

async function markAllNotificationsRead(userId) {
  const { rows } = await pool.query(
    `UPDATE notifications SET read_at = COALESCE(read_at, NOW())
     WHERE user_id = $1 AND read_at IS NULL
     RETURNING id`,
    [userId]
  );
  return rows.length;
}

async function deleteNotification(userId, notificationId) {
  const { rows } = await pool.query(
    'DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id',
    [notificationId, userId]
  );
  return rows[0] || null;
}

// ── BizFlow user data (per-user JSONB document) ─────────────────────────────
async function getBizflowData(userId) {
  const { rows } = await pool.query(
    'SELECT data FROM bizflow_data WHERE user_id = $1',
    [userId]
  );
  return rows[0] ? rows[0].data : null;
}

async function saveBizflowData(userId, data) {
  const { rows } = await pool.query(
    `INSERT INTO bizflow_data (user_id, data, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
     DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()
     RETURNING data`,
    [userId, JSON.stringify(data)]
  );
  return rows[0].data;
}

async function getPendingVtuOrders(userId) {
  const { rows } = await pool.query(
    `SELECT request_id, service_type, amount, description, provider_order_id, created_at
     FROM vtu_orders WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 5`,
    [userId]
  );
  return rows;
}

// ── Provider reference backfill (rescue of previously-untraceable orders) ──
// Before the ordernumber extraction fix, a legitimate pending order could be
// stored with provider_order_id NULL even though its raw provider response
// (provider_response jsonb) DID carry the reference under ordernumber /
// OrderNumber / order_id etc. Those orders were untraceable and would be
// auto-expired as 'failed - not charged'. This pass rescues them by re-reading
// the stored raw payload and persisting the extracted reference, so the
// reconcile sweep and the on-demand status endpoint can trace and settle them
// like any other pending order. Tentative pending orders are handled first.
async function backfillVtuOrderProviderIds({ limit = 50 } = {}) {
  const { rows } = await pool.query(
    `SELECT request_id, provider_response
     FROM vtu_orders
     WHERE status = 'pending'
       AND (provider_order_id IS NULL OR provider_order_id = '')
       AND provider_response IS NOT NULL
       AND provider_response <> '{}'::jsonb
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );

  let recovered = 0;
  for (const row of rows) {
    const ref = extractOrderReference(row.provider_response);
    if (!ref) continue;
    await pool.query(
      `UPDATE vtu_orders SET provider_order_id = $2, updated_at = NOW()
       WHERE request_id = $1 AND (provider_order_id IS NULL OR provider_order_id = '')`,
      [row.request_id, ref]
    );
    recovered += 1;
  }
  return { scanned: rows.length, recovered };
}

// Extract the first genuine provider reference from a raw response object.
// Accepts the same key set as normalizeClubkonnectResponse and rejects
// placeholders ('0', '', 'undefined', 'null') so no order is made falsely
// 'traceable'.
function extractOrderReference(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const candidates = [
    raw.orderId, raw.OrderID, raw.OrderId,
    raw.OrderNumber, raw.ordernumber, raw.orderNumber,
    raw.order_id, raw.OrderNo, raw.orderno,
  ];
  const value = candidates
    .map((v) => (v === null || v === undefined ? '' : String(v).trim()))
    .find((v) => v && v !== '0' && v.toLowerCase() !== 'undefined' && v.toLowerCase() !== 'null');
  return value || null;
}

// ── Stale pending order expiry (auto-resolution) ────────────────────────────
// Clubkonnect never returned a provider order ID for these, so they are
// untraceable and their wallets were NEVER debited (that only happens on a
// terminal provider success inside completeVtuOrder). Leaving them 'pending'
// forever is confusing, so after a grace window they are safely moved to
// 'failed — not charged'. Only orders without a provider_order_id are eligible:
// orders WITH a provider reference stay pending for manual reconciliation.
async function expireStaleVtuOrders({ olderThanMinutes = 10, limit = 100 } = {}) {
  const { rows } = await pool.query(
    `SELECT request_id, user_id, service_type, amount, description
     FROM vtu_orders
     WHERE status = 'pending'
       AND (provider_order_id IS NULL OR provider_order_id = '')
       AND created_at < NOW() - make_interval(mins => $1)
     ORDER BY created_at ASC
     LIMIT $2`,
    [olderThanMinutes, limit]
  );
  const expired = [];
  for (const row of rows) {
    try {
      await markVtuOrderFailed(row.request_id, {
        allowPending: true,
        failureSuffix: ' — provider did not confirm, not charged',
      });
      expired.push(row);
    } catch (err) {
      console.error(`Auto-expire failed for ${row.request_id}: ${err.message}`);
    }
  }
  return { scanned: rows.length, expired: expired.length, orders: expired };
}

// ── Stale submitted order cleanup ───────────────────────────────────────────
// Pre-idempotency artifacts or interrupted flows that stalled in 'submitted'
// with no transaction_id and no provider_order_id. These were NEVER debited.
async function cleanStaleSubmittedOrders({ olderThanHours = 24, limit = 50 } = {}) {
  const { rowCount } = await pool.query(
    `UPDATE vtu_orders SET status = 'failed', updated_at = NOW()
     WHERE request_id IN (
       SELECT request_id FROM vtu_orders
       WHERE status = 'submitted'
         AND transaction_id IS NULL
         AND (provider_order_id IS NULL OR provider_order_id = '')
         AND created_at < NOW() - make_interval(hours => $1)
       LIMIT $2
     )`,
    [olderThanHours, limit]
  );
  return rowCount;
}

// ── Pending order reconciliation (auto-resolution) ──────────────────────────
// Pending orders that DO carry a provider order ID are traceable via the
// provider Query API. Return the oldest few that have not been reconciled in
// the backoff window (so the sweeper never hammers the provider on every tick),
// and stop automatically once an order has had enough attempts — from then on
// only a human admin resolves it.
async function getReconcilablePendingOrders({ backoffMinutes = 10, maxAttempts = 30, limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT request_id FROM vtu_orders
     WHERE status = 'pending'
       AND provider_order_id IS NOT NULL AND provider_order_id <> ''
       AND reconcile_attempts < $1
       AND (last_reconciled_at IS NULL OR last_reconciled_at < NOW() - make_interval(mins => $2))
     ORDER BY created_at ASC
     LIMIT $3`,
    [maxAttempts, backoffMinutes, limit]
  );
  return rows;
}

// ── Auto-recharge ────────────────────────────────────────────────────────────
async function setAutoRecharge(userId, { threshold, amount }) {
  const { rows } = await pool.query(
    `INSERT INTO auto_recharges (user_id, threshold, amount)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET threshold = $2, amount = $3, active = true, updated_at = NOW()
     RETURNING *`,
    [userId, threshold, amount]
  );
  return rows[0];
}

async function getAutoRecharge(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM auto_recharges WHERE user_id = $1', [userId]
  );
  return rows[0] || null;
}

async function deleteAutoRecharge(userId) {
  await pool.query(
    'UPDATE auto_recharges SET active = false, updated_at = NOW() WHERE user_id = $1',
    [userId]
  );
}

async function getDueAutoRecharges(limit = 20) {
  const { rows } = await pool.query(
    `SELECT a.*, u.email, u.full_name, u.wallet
     FROM auto_recharges a JOIN users u ON u.id = a.user_id
     WHERE a.active = true AND u.wallet <= a.threshold
       AND (a.last_triggered_at IS NULL OR a.last_triggered_at < NOW() - INTERVAL '1 hour')
       AND a.failed_attempts < 3
     ORDER BY u.wallet ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function markAutoRechargeTriggered(userId) {
  await pool.query(
    `UPDATE auto_recharges SET last_triggered_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
    [userId]
  );
}

// ── Pending auto-recharge checkout sessions ──────────────────────────────────
async function createAutoRechargeSession(userId, { reference, authorizationUrl, amount }) {
  const { rows } = await pool.query(
    `INSERT INTO auto_recharge_sessions (user_id, reference, authorization_url, amount)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (reference) DO NOTHING
     RETURNING *`,
    [userId, reference, authorizationUrl, amount]
  );
  return rows[0] || null;
}

async function getPendingAutoRechargeSession(userId) {
  const { rows } = await pool.query(
    `SELECT id, user_id, reference, authorization_url, amount, created_at
     FROM auto_recharge_sessions
     WHERE user_id = $1 AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [userId]
  );
  return rows[0] || null;
}

async function completeAutoRechargeSession(reference) {
  await pool.query(
    `UPDATE auto_recharge_sessions SET status = 'completed', updated_at = NOW() WHERE reference = $1`,
    [reference]
  );
}

// ── Scheduled purchases ───────────────────────────────────────────────────────
async function createScheduledPurchase(userId, data) {
  const { serviceType, planCode, phone, identifier, network, amount, frequency, nextRunAt } = data;
  const { rows } = await pool.query(
    `INSERT INTO scheduled_purchases
       (user_id, service_type, plan_code, phone, identifier, network, amount, frequency, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [userId, serviceType, planCode || null, phone || null, identifier || null, network || null, amount, frequency, nextRunAt]
  );
  return rows[0];
}

async function getScheduledPurchases(userId) {
  const { rows } = await pool.query(
    'SELECT * FROM scheduled_purchases WHERE user_id = $1 ORDER BY next_run_at ASC',
    [userId]
  );
  return rows;
}

async function deleteScheduledPurchase(userId, id) {
  const { rowCount } = await pool.query(
    'DELETE FROM scheduled_purchases WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return rowCount > 0;
}

async function getDueScheduledPurchases(limit = 20) {
  const { rows } = await pool.query(
    `SELECT sp.*, u.email, u.full_name, u.wallet
     FROM scheduled_purchases sp JOIN users u ON u.id = sp.user_id
     WHERE sp.active = true AND sp.next_run_at <= NOW()
     ORDER BY sp.next_run_at ASC LIMIT $1`,
    [limit]
  );
  return rows;
}

async function withScheduledPurchaseLock(id, callback) {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock(424242, $1) AS locked', [id]);
    locked = rows[0]?.locked === true;
    if (!locked) return { skippedLocked: true };
    return await callback();
  } finally {
    if (locked) await client.query('SELECT pg_advisory_unlock(424242, $1)', [id]).catch(() => {});
    client.release();
  }
}

async function getOrCreateScheduledReference(id, generatedReference) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT active, next_run_at, in_flight_for, in_flight_reference FROM scheduled_purchases WHERE id = $1 FOR UPDATE',
      [id]
    );
    const row = rows[0];
    if (!row) throw new Error(`Scheduled purchase ${id} not found`);
    if (!row.active || new Date(row.next_run_at).getTime() > Date.now()) {
      await client.query('COMMIT');
      return null;
    }
    const sameOccurrence = row.in_flight_reference && row.in_flight_for
      && new Date(row.in_flight_for).getTime() === new Date(row.next_run_at).getTime();
    const reference = sameOccurrence ? row.in_flight_reference : generatedReference;
    if (!sameOccurrence) {
      await client.query(
        `UPDATE scheduled_purchases
         SET in_flight_reference = $2, in_flight_for = next_run_at, updated_at = NOW()
         WHERE id = $1`,
        [id, reference]
      );
    }
    await client.query('COMMIT');
    return reference;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function recordScheduledRun(id, nextRun) {
  await pool.query(
    `UPDATE scheduled_purchases
     SET last_run_at = NOW(), run_count = run_count + 1,
         next_run_at = $2, in_flight_reference = NULL, in_flight_for = NULL, updated_at = NOW()
     WHERE id = $1`,
    [id, nextRun]
  );
}

async function disableScheduledPurchase(id) {
  await pool.query(
    `UPDATE scheduled_purchases
     SET active = false, last_run_at = NOW(), run_count = run_count + 1,
         updated_at = NOW(), in_flight_reference = NULL, in_flight_for = NULL
     WHERE id = $1`,
    [id]
  );
}

async function setScheduledPurchaseActive(userId, id, active) {
  const { rows: [row] } = await pool.query(
    `UPDATE scheduled_purchases
     SET active = $3,
         next_run_at = CASE WHEN $3 AND next_run_at <= NOW() THEN NOW() + INTERVAL '5 minutes' ELSE next_run_at END,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING *`,
    [id, userId, active]
  );
  return row || null;
}

async function getScheduledPurchaseById(userId, id) {
  const { rows: [row] } = await pool.query(
    'SELECT * FROM scheduled_purchases WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return row || null;
}

async function getVtuOrdersByUser(userId, { limit = 20 } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM vtu_orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// ── Financial reconciliation ────────────────────────────────────────────────
async function getFinancialReconciliation() {
  const { rows: [walletSum] } = await pool.query(
    'SELECT COALESCE(SUM(wallet), 0)::numeric(12,2) AS total FROM users'
  );
  const { rows: [ledgerSum] } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0)
            - COALESCE(SUM(CASE WHEN type = 'debit' AND status = 'completed' THEN amount ELSE 0 END), 0)
              AS total FROM transactions`
  );
  const drift = parseFloat(walletSum.total) - parseFloat(ledgerSum.total);
  const { rows: flagged } = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.wallet,
            COALESCE(t.net, 0) AS tx_net
     FROM users u LEFT JOIN (
       SELECT user_id,
              COALESCE(SUM(CASE WHEN type = 'credit' THEN amount ELSE 0 END), 0)
              - COALESCE(SUM(CASE WHEN type = 'debit' AND status = 'completed' THEN amount ELSE 0 END), 0)
                AS net
       FROM transactions GROUP BY user_id
     ) t ON t.user_id = u.id
     WHERE ABS(u.wallet - COALESCE(t.net, 0)) > 0.01`
  );
  return {
    walletTotal: walletSum.total,
    ledgerTotal: ledgerSum.total,
    drift: drift.toFixed(2),
    ok: Math.abs(drift) < 0.01,
    flaggedUsers: flagged.map(r => ({
      id: r.id, email: r.email, name: r.full_name,
      wallet: r.wallet, txNet: r.tx_net,
      diff: (parseFloat(r.wallet) - parseFloat(r.tx_net)).toFixed(2),
    })),
  };
}

module.exports = {
  initDB,
  closePool,
  ping,
  findUserByEmail,
  findUserByPhone,
  findUserById,
  createUser,
  findUserByReferralCode,
  verifyPassword,
  updateUserPassword,
  getWalletBalance,
  creditWallet,
  debitWallet,
  getTransactions,
  logFailedTransaction,
  createVtuAttempt,
  createDirectOrder,
  findOrderByPaymentReference,
  markOrderPaid,
  acquireVtuIdempotency,
  recordVtuIdempotencyResult,
  recordVtuProviderResponse,
  recordReconciliationAttempt,
  completeVtuOrder,
  completeDirectOrder,
  markVtuOrderPending,
  markVtuOrderFailed,
  promoteToAdmin,
  getVtuOrderByRequestId,
  createPasswordReset,
  consumePasswordReset,
  paystackRefExists,
  savePaystackRef,
  creditVerifiedPaystackPayment,
  getAdminStats,
  getAllTransactions,
  getAllUsers,
  getAdminVtuOrders,
  setTransactionPin,
  verifyTransactionPin,
  hasTransactionPin,
  ensureReferralCode,
  getReferralStats,
  getBeneficiaries,
  addBeneficiary,
  deleteBeneficiary,
  getAnalyticsSummary,
  getBizflowData,
  saveBizflowData,
  getPendingVtuOrders,
  backfillVtuOrderProviderIds,
  expireStaleVtuOrders,
  cleanStaleSubmittedOrders,
  getReconcilablePendingOrders,
  getFinancialReconciliation,
  setAutoRecharge,
  getAutoRecharge,
  deleteAutoRecharge,
  getDueAutoRecharges,
  markAutoRechargeTriggered,
  createAutoRechargeSession,
  getPendingAutoRechargeSession,
  completeAutoRechargeSession,
  createScheduledPurchase,
  getScheduledPurchases,
  deleteScheduledPurchase,
  getDueScheduledPurchases,
  withScheduledPurchaseLock,
  getOrCreateScheduledReference,
  recordScheduledRun,
  disableScheduledPurchase,
  setScheduledPurchaseActive,
  getScheduledPurchaseById,
  getVtuOrdersByUser,
  createNotification,
  getNotifications,
  getUnreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
  deleteNotification,
};
