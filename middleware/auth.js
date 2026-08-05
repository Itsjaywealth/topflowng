/**
 * TopFlowNG — Auth + authorization middleware.
 *
 * Extracted from server.js without behaviour change. JWT payload is verified
 * with the configured secret; admin guard loads the real user from the DB.
 */

'use strict';

const jwt = require('jsonwebtoken');

const config = require('../config');
const db = require('../database');
const { sendError, unauthorized, forbidden } = require('../lib/errors');

function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    return sendError(res, 401, 'No token provided');
  }
  try {
    req.user = jwt.verify(token, config.jwt.secret);
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

module.exports = { authMiddleware, adminMiddleware, checkTransactionPin };
