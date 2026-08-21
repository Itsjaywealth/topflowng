/**
 * TopFlowNG — Auth + authorization middleware.
 *
 * JWT payload is verified with the configured secret; revoked tokens are
 * rejected; admin guard loads the real user from the DB. Continuous with the
 * Phase 2 extraction — behaviour of protected routes is unchanged.
 */

'use strict';

const jwt = require('jsonwebtoken');

const config = require('../config');
const db = require('../database');
const security = require('../services/security');
const { sendError } = require('../lib/errors');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return sendError(res, 401, 'No token provided');
  }
  if (security.isTokenRevoked(token)) {
    return sendError(res, 401, 'Invalid or expired token');
  }
  try {
    req.user = jwt.verify(token, config.jwt.secret);
    req.token = token;
    return next();
  } catch {
    return sendError(res, 401, 'Invalid or expired token');
  }
}

async function adminMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return sendError(res, 401, 'No token provided');
  }
  if (security.isTokenRevoked(token)) {
    return sendError(res, 401, 'Invalid or expired token');
  }
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await db.findUserById(payload.id);
    if (!user || !user.is_admin) {
      return sendError(res, 403, 'Admin access required');
    }
    req.user = payload;
    return next();
  } catch {
    return sendError(res, 401, 'Invalid or expired token');
  }
}

async function checkTransactionPin(userId, pin) {
  const hasPinSet = await db.hasTransactionPin(userId);
  if (!hasPinSet) return;
  if (!pin) {
    const err = new Error('Transaction PIN required');
    err.code = 'PIN_REQUIRED';
    throw err;
  }
  const valid = await db.verifyTransactionPin(userId, pin);
  if (!valid) {
    const err = new Error('Incorrect transaction PIN');
    err.code = 'PIN_INVALID';
    throw err;
  }
}

module.exports = { authMiddleware, adminMiddleware, ownerMiddleware, checkTransactionPin };

/**
 * Owner / super-admin guard. Requires ALL of:
 *   - a valid, non-revoked JWT,
 *   - the account loaded from the DB with is_admin = true (no token-only trust),
 *   - the account email present in the server-side OWNER_EMAILS allow-list.
 * Ordinary users and ordinary admins can never pass. There is intentionally
 * no frontend path that grants ownership — the allow-list lives in env only.
 */
async function ownerMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return sendError(res, 401, 'No token provided');
  }
  if (security.isTokenRevoked(token)) {
    return sendError(res, 401, 'Invalid or expired token');
  }
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user = await db.findUserById(payload.id);
    if (!user || !user.is_admin) {
      return sendError(res, 403, 'Owner access required');
    }
    if (!config.ownerEmails.includes(String(user.email).toLowerCase())) {
      return sendError(res, 403, 'Owner access required');
    }
    req.user = payload;
    req.isOwner = true;
    return next();
  } catch {
    return sendError(res, 401, 'Invalid or expired token');
  }
}
