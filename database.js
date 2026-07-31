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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
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
    await client.query('CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id)');
    await client.query('CREATE INDEX IF NOT EXISTS idx_txn_date ON transactions(created_at DESC)');
    console.log('PostgreSQL initialised');
  } finally {
    client.release();
  }
}

async function createUser({ fullName, email, phone, password }) {
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query(
    'INSERT INTO users (full_name,email,phone,password) VALUES ($1,$2,$3,$4) RETURNING id,full_name,email,phone,wallet,created_at',
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
    'SELECT id,full_name,email,phone,wallet,created_at FROM users WHERE id=$1', [id]
  );
  return rows[0] || null;
}

async function verifyPassword(user, password) {
  return bcrypt.compare(password, user.password);
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

module.exports = {
  initDB, pool, createUser, findUserByEmail, findUserByPhone, findUserById,
  verifyPassword, getWalletBalance, creditWallet, debitWallet,
  getTransactions, logFailedTransaction, paystackRefExists, savePaystackRef,
};
