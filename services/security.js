/**
 * TopFlowNG — Account security: login failure lockout + token revocation.
 *
 * In-memory only (resets on restart). Good enough for a single-instance app;
 * documented limitation in INTERNAL-PLAN.md. Never logs tokens or emails.
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
};