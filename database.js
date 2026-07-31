'use strict';

const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => { console.error('PG pool error:', err); });

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      full_name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      phone TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      wallet NUMERIC(12,2) NOT NULL DEFAULT 0,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    // Add is_admin column to existing tables (safe migration)
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE`);
    await client.query(`CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      description TEXT NOT NULL,
      amount NUMERIC(12,2) NOT NULL,
      status TEXT NOT NULL DEFAULT 'success',
      ref TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS paystack_refs (
      ref TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      amount NUMERIC(12,2) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query(`CREATE TABLE IF NOT EXISTS password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query('CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(created_at DESC)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_pr_token ON password_resets(token)');
    console.log('PostgreSQL initialised');
  } finally {
    client.release();
  }
}

async function createUser({ fullName, email, phone, password }) {
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    'INSERT INTO users (full_name,email,phone,password) VALUES ($1,$2,$3,$4) RETURNING id,full_name,email,phone,wallet,is_admin,created_at',
    [fullName, email.toLowerCase().trim(), phone.trim(), hash]
  );
  return rows[0];
}

async function findUserByEmail(email) {
  const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [email.toLowerCase().trim()]);
  return rows[0] || null;
}

async function findUserByPhone(phone) {
  const { rows } = await pool.query('SELECT * FROM users WHERE phone=$1', [phone.trim()]);
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await pool.query(
    'SELECT id,full_name,email,phone,wallet,is_admin,created_at FROM users WHERE id=$1', [id]
  );
  return rows[0] || null;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password);
}

async function updateUserPassword(userId, newPassword) {
  const hash = await bcrypt.hash(newPassword, 12);
  await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hash, userId]);
}

async function getWalletBalance(userId) {
  const { rows } = await pool.query('SELECT wallet FROM users WHERE id=$1', [userId]);
  return rows[0] ? parseFloat(rows[0].wallet) : 0;
}

async function creditWallet(userId, amount, description, ref) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'UPDATE users SET wallet=wallet+$1 WHERE id=$2 RETURNING wallet', [amount, userId]
    );
    await client.query(
      "INSERT INTO transactions(user_id,type,description,amount,status,ref) VALUES($1,'credit',$2,$3,'success',$4)",
      [userId, description, amount, ref || null]
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

async function debitWallet(userId, amount, description, ref) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: bal } = await client.query(
      'SELECT wallet FROM users WHERE id=$1 FOR UPDATE', [userId]
    );
    if (parseFloat(bal[0].wallet) < amount) {
      await client.query('ROLLBACK');
      throw new Error('Insufficient wallet balance');
    }
    const { rows } = await client.query(
      'UPDATE users SET wallet=wallet-$1 WHERE id=$2 RETURNING wallet', [amount, userId]
    );
    await client.query(
      "INSERT INTO transactions(user_id,type,description,amount,status,ref) VALUES($1,'debit',$2,$3,'success',$4)",
      [userId, description, amount, ref || null]
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

async function getTransactions(userId, limit) {
  const { rows } = await pool.query(
    'SELECT id,type,description,amount,status,ref,created_at FROM transactions WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2',
    [userId, limit || 20]
  );
  return rows;
}

async function logFailedTransaction(userId, description, amount) {
  await pool.query(
    "INSERT INTO transactions(user_id,type,description,amount,status) VALUES($1,'debit',$2,$3,'failed')",
    [userId, description, amount]
  );
}

async function paystackRefExists(ref) {
  const { rows } = await pool.query('SELECT 1 FROM paystack_refs WHERE ref=$1', [ref]);
  return rows.length > 0;
}

async function savePaystackRef(ref, userId, amount) {
  await pool.query(
    'INSERT INTO paystack_refs(ref,user_id,amount) VALUES($1,$2,$3) ON CONFLICT(ref) DO NOTHING',
    [ref, userId, amount]
  );
}

// ── Password Reset ────────────────────────────────────────────────────────────

async function createPasswordReset(userId, token) {
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
  // Invalidate previous tokens for this user
  await pool.query('UPDATE password_resets SET used=TRUE WHERE user_id=$1 AND used=FALSE', [userId]);
  await pool.query(
    'INSERT INTO password_resets(user_id,token,expires_at) VALUES($1,$2,$3)',
    [userId, token, expiresAt]
  );
}

async function findValidPasswordReset(token) {
  const { rows } = await pool.query(
    'SELECT pr.*, u.email, u.full_name FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token=$1 AND pr.used=FALSE AND pr.expires_at > NOW()',
    [token]
  );
  return rows[0] || null;
}

async function consumePasswordReset(token, newPassword) {
  const reset = await findValidPasswordReset(token);
  if (!reset) throw new Error('Invalid or expired reset token');
  await updateUserPassword(reset.user_id, newPassword);
  await pool.query('UPDATE password_resets SET used=TRUE WHERE token=$1', [token]);
  return reset;
}

// ── Admin Queries ─────────────────────────────────────────────────────────────

async function getAdminStats() {
  const { rows: users } = await pool.query('SELECT COUNT(*) as total FROM users');
  const { rows: txns } = await pool.query("SELECT COUNT(*) as total, COALESCE(SUM(amount),0) as volume FROM transactions WHERE status='success'");
  const { rows: credits } = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='credit' AND status='success'");
  const { rows: debits } = await pool.query("SELECT COALESCE(SUM(amount),0) as total FROM transactions WHERE type='debit' AND status='success'");
  const { rows: today } = await pool.query("SELECT COUNT(*) as total FROM transactions WHERE created_at > NOW()-INTERVAL '24 hours'");
  return {
    totalUsers: parseInt(users[0].total),
    totalTransactions: parseInt(txns[0].total),
    totalVolume: parseFloat(txns[0].volume),
    totalDeposits: parseFloat(credits[0].total),
    totalSpend: parseFloat(debits[0].total),
    todayTransactions: parseInt(today[0].total),
  };
}

async function getAllTransactions(limit, offset) {
  const { rows } = await pool.query(
    `SELECT t.id, t.type, t.description, t.amount, t.status, t.ref, t.created_at,
            u.full_name, u.email, u.phone
     FROM transactions t JOIN users u ON u.id=t.user_id
     ORDER BY t.created_at DESC LIMIT $1 OFFSET $2`,
    [limit || 50, offset || 0]
  );
  return rows;
}

async function getAllUsers(limit, offset) {
  const { rows } = await pool.query(
    'SELECT id, full_name, email, phone, wallet, is_admin, created_at FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
    [limit || 50, offset || 0]
  );
  return rows;
}

module.exports = {
  initDB, pool,
  createUser, findUserByEmail, findUserByPhone, findUserById,
  verifyPassword, updateUserPassword,
  getWalletBalance, creditWallet, debitWallet,
  getTransactions, logFailedTransaction,
  paystackRefExists, savePaystackRef,
  createPasswordReset, findValidPasswordReset, consumePasswordReset,
  getAdminStats, getAllTransactions, getAllUsers,
};
