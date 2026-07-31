/**
 * TopFlowNG — SQLite Database Layer
 * Uses better-sqlite3 (synchronous, no callback hell, ACID-compliant)
 *
 * Tables:
 *   users        — accounts, wallet balances
 *   transactions — every debit and credit, permanently persisted
 *   paystack_refs— tracks Paystack payment references to prevent double-credit
 */

const Database = require("better-sqlite3");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// Database file lives in the project root. Back this file up regularly.
const DB_PATH = path.join(__dirname, "topflowng.db");
const db = new Database(DB_PATH);

// ── Performance & safety pragmas ────────────────
db.pragma("journal_mode = WAL");   // Write-Ahead Logging: faster concurrent reads
db.pragma("foreign_keys = ON");    // Enforce FK constraints
db.pragma("synchronous = NORMAL"); // Good balance of durability vs speed

// ═══════════════════════════════════════════════
// SCHEMA
// ═══════════════════════════════════════════════
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY,
    first_name      TEXT NOT NULL,
    last_name       TEXT NOT NULL,
    email           TEXT UNIQUE NOT NULL,
    phone           TEXT UNIQUE NOT NULL,
    password_hash   TEXT NOT NULL,
    wallet_balance  REAL NOT NULL DEFAULT 0,
    is_verified     INTEGER NOT NULL DEFAULT 0,
    is_reseller     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id                TEXT PRIMARY KEY,
    user_id           TEXT NOT NULL,
    type              TEXT NOT NULL CHECK(type IN ('credit','debit')),
    amount            REAL NOT NULL CHECK(amount > 0),
    description       TEXT,
    service           TEXT,
    status            TEXT NOT NULL DEFAULT 'success',
    reference         TEXT,
    provider_response TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_txn_user ON transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_txn_ref  ON transactions(reference);

  CREATE TABLE IF NOT EXISTS paystack_refs (
    reference   TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    amount_naira REAL NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ═══════════════════════════════════════════════
// PREPARED STATEMENTS
// ═══════════════════════════════════════════════

const stmt = {
  // ── Users ──
  createUser: db.prepare(`
    INSERT INTO users (id, first_name, last_name, email, phone, password_hash)
    VALUES (@id, @first_name, @last_name, @email, @phone, @password_hash)
  `),
  userByEmail: db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE"),
  userByPhone: db.prepare("SELECT * FROM users WHERE phone = ?"),
  userById:    db.prepare("SELECT * FROM users WHERE id = ?"),
  // Delta can be positive (credit) or negative (debit)
  adjustBalance: db.prepare(`
    UPDATE users
    SET wallet_balance = wallet_balance + @delta,
        updated_at = datetime('now')
    WHERE id = @id
  `),

  // ── Transactions ──
  insertTxn: db.prepare(`
    INSERT INTO transactions
      (id, user_id, type, amount, description, service, status, reference, provider_response)
    VALUES
      (@id, @user_id, @type, @amount, @description, @service, @status, @reference, @provider_response)
  `),
  txnsByUser: db.prepare(`
    SELECT * FROM transactions WHERE user_id = ?
    ORDER BY created_at DESC LIMIT 30
  `),
  txnByRef: db.prepare("SELECT * FROM transactions WHERE reference = ?"),

  // ── Paystack refs ──
  insertPsRef: db.prepare(`
    INSERT INTO paystack_refs (reference, user_id, amount_naira)
    VALUES (@reference, @user_id, @amount_naira)
  `),
  psRefByRef:    db.prepare("SELECT * FROM paystack_refs WHERE reference = ?"),
  completePsRef: db.prepare(`
    UPDATE paystack_refs SET status = 'completed' WHERE reference = ?
  `),
};

// ═══════════════════════════════════════════════
// WALLET OPERATIONS  (atomic — use db.transaction)
// ═══════════════════════════════════════════════

/**
 * Credit a user's wallet. Creates a transaction record.
 * Returns updated user row.
 */
const creditWallet = db.transaction((userId, amount, description, opts = {}) => {
  const { service = "wallet", reference = null, providerData = null } = opts;

  // Guard: don't double-credit same Paystack reference
  if (reference) {
    const existing = stmt.txnByRef.get(reference);
    if (existing) {
      console.warn(`[DB] Duplicate reference blocked: ${reference}`);
      return stmt.userById.get(userId);
    }
  }

  stmt.adjustBalance.run({ delta: amount, id: userId });
  stmt.insertTxn.run({
    id:                uuidv4(),
    user_id:           userId,
    type:              "credit",
    amount,
    description,
    service,
    status:            "success",
    reference,
    provider_response: providerData ? JSON.stringify(providerData) : null,
  });

  return stmt.userById.get(userId);
});

/**
 * Debit a user's wallet. Throws if balance insufficient.
 * Returns the new transaction ID.
 */
const debitWallet = db.transaction((userId, amount, description, opts = {}) => {
  const { service = "vtu", reference = null } = opts;

  const user = stmt.userById.get(userId);
  if (!user) throw new Error("User not found");
  if (user.wallet_balance < amount) throw new Error("Insufficient wallet balance");

  stmt.adjustBalance.run({ delta: -amount, id: userId });

  const txnId = uuidv4();
  stmt.insertTxn.run({
    id:                txnId,
    user_id:           userId,
    type:              "debit",
    amount,
    description,
    service,
    status:            "success",
    reference,
    provider_response: null,
  });

  return txnId;
});

/**
 * Refund a debit — re-credits the wallet after a failed VTU call.
 */
const refundWallet = (userId, amount, description) =>
  creditWallet(userId, amount, description, { service: "refund" });

// ═══════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════
module.exports = {
  db,
  stmt,
  creditWallet,
  debitWallet,
  refundWallet,
};
