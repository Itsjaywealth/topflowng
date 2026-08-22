/**
 * TopFlowNG — Account security: login failure lockout + token revocation.
 *
 * Revocations are held in an in-memory map for O(1) request-path checks AND
 * persisted to the revoked_tokens table (sha256 hashes only), so a logout
 * survives server restarts. The map is hydrated from Postgres at boot.
 * Never logs tokens or emails.
 */

'use strict';

const crypto = require('crypto');

const config = require('../config');

const loginFailures = new Map(); // normalizedEmail -> { count, windowStart, lockedUntil }
const revokedTokens = new Map(); // sha256(token) -> expiresAt (ms)

function pruneRevoked() {
  const now = Date.now();
  for (const [hash, expiresAt] of revokedTokens) {
    if (expiresAt <= now) revokedTokens.delete(hash);
  }
}

// ── Login failure lockout ──────────────────────────────────────────────────
function recordLoginFailure(email) {
  const key = String(email || '').trim().toLowerCase();
  const now = Date.now();
  const entry = loginFailures.get(key);
  if (!entry || now - entry.windowStart > config.auth.lockoutWindowMs) {
    loginFailures.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
  } else {
    entry.count += 1;
    if (entry.count >= config.auth.loginMaxFailures && !entry.lockedUntil) {
      entry.lockedUntil = now + config.auth.lockoutDurationMs;
    }
  }
}

function resetLoginFailures(email) {
  loginFailures.delete(String(email || '').trim().toLowerCase());
}

function isLockedOut(email) {
  const key = String(email || '').trim().toLowerCase();
  const entry = loginFailures.get(key);
  if (!entry) return false;
  const now = Date.now();

  if (entry.lockedUntil) {
    if (now < entry.lockedUntil) return true;
    loginFailures.delete(key);
    return false;
  }

  if (now - entry.windowStart > config.auth.lockoutWindowMs) {
    loginFailures.delete(key);
    return false;
  }
  return entry.count >= config.auth.loginMaxFailures;
}

// ── Token revocation (logout) ──────────────────────────────────────────────
function revokeToken(token) {
  if (!token) return;
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
  let expiresAt = Date.now() + 30 * 60 * 1000; // fallback if exp unknown
  try {
    const decoded = require('jsonwebtoken').decode(token);
    if (decoded && typeof decoded.exp === 'number') {
      expiresAt = decoded.exp * 1000;
    }
  } catch { /* ignore malformed */ }
  revokedTokens.set(hash, expiresAt);
  pruneRevoked();
  persistRevocation(hash, expiresAt);
}

// Fire-and-forget persistence — a failed write must never break logout, and
// the in-memory map already covers this process. Lazy require avoids a
// circular import (database.js does not import this module today, but stay safe).
function persistRevocation(hash, expiresAt) {
  Promise.resolve().then(() => {
    const db = require('../database');
    return db.pool.query(
      `INSERT INTO revoked_tokens (token_hash, expires_at) VALUES ($1, $2)
       ON CONFLICT (token_hash) DO NOTHING`,
      [hash, new Date(expiresAt).toISOString()]
    );
  }).catch(() => {});
}

// Load every unexpired revocation recorded by previous process lifetimes.
async function hydrateRevocations() {
  try {
    const db = require('../database');
    const { rows } = await db.pool.query(
      'SELECT token_hash, expires_at FROM revoked_tokens WHERE expires_at > NOW()'
    );
    for (const row of rows) {
      revokedTokens.set(row.token_hash, new Date(row.expires_at).getTime());
    }
    // Opportunistic cleanup of long-expired rows.
    await db.pool.query('DELETE FROM revoked_tokens WHERE expires_at < NOW() - INTERVAL \'1 day\'');
    return rows.length;
  } catch {
    return 0; // table may not exist yet mid-deploy — degrade gracefully
  }
}

function isTokenRevoked(token) {
  if (!token) return false;
  const hash = crypto.createHash('sha256').update(String(token)).digest('hex');
  return revokedTokens.has(hash);
}

module.exports = {
  recordLoginFailure,
  resetLoginFailures,
  isLockedOut,
  revokeToken,
  isTokenRevoked,
  hydrateRevocations,
};