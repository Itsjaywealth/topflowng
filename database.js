'use strict';

/**
 * TopFlowNG â PostgreSQL Database Layer
 * Tables: users, transactions, password_resets, paystack_refs
 */

const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const SALT_ROUNDS = 12;

// ââ Schema Init ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

      CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    `);

    // Add is_admin column if it doesn't exist (migration safety)
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
    `).catch(() => {});

    console.log('Database schema ready');
  } finally {
    client.release();
  }
}

// ââ User Queries ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

async function createUser({ fullName, email, phone, password }) {
  const hash = await bcrypt.hash(password, SALT_ROUNDS);
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, phone, password)
     VALUES ($1, $2, $3, $4)
     RETURNING id, full_name, email, phone, wallet, is_admin`,
    [fullName, email, phone, hash]
  );
  return rows[0];
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password);
}

async function updateUserPassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, SALT_ROUNDS);
  await pool.query('UPDATE users SET password = $1 WHERE id = $2', [hash, userId]);
}

// ââ Wallet ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

async function getTransactions(userId, limit = 20) {
  const { rows } = await pool.query(
    `SELECT id, type, amount, description, reference, created_at
     FROM transactions WHERE user_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function logFailedTransaction(userId, description, amount) {
  await pool.query(
    `INSERT INTO transactions (user_id, type, amount, description, reference)
     VALUES ($1, 'debit', $2, $3, 'FAILED')`,
    [userId, amount, description]
  ).catch(err => console.error('Failed to log failed transaction:', err.message));
}

// ââ Password Reset ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Paystack Idempotency ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

// ââ Admin Queries âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function getAdminStats() {
  const { rows } = await pool.query(`
    SELECT
      (SELECT COUNT(*) FROM users)::int                                           AS total_users,
      (SELECT COUNT(*) FROM transactions)::int                                    AS total_transactions,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'credit')  AS total_credited,
      (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE type = 'debit'
         AND reference != 'FAILED')                                               AS total_debited
  `);
  return rows[0];
}

async function getAllTransactions(limit = 50, offset = 0) {
  const { rows } = await pool.query(
    `SELECT
       t.id, t.type, t.amount, t.description, t.reference, t.created_at,
       u.full_name AS user_name, u.email AS user_email
     FROM transactions t
     JOIN users u ON u.id = t.user_id
     ORDER BY t.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

acync function getAllUsers(limit = 50, offset = 0) {
  const { rows } = await pool.query(
    `SELECT id, full_name, email, phone, wallet, is_admin, created_at
     FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  return rows;
}

module.exports = {
  initDB,
  findUserByEmail,
  findUserByPhone,
  findUserById,
  createUser,
  verifyPassword,
  updateUserPassword,
  getWalletBalance,
  creditWallet,
  debitWallet,
  getTransactions,
  logFailedTransaction,
  createPasswordReset,
  consumePasswordReset,
  paystackRefExists,
  savePaystackRef,
  getAdminStats,
  getAllTransactions,
  getAllUsers,
};
