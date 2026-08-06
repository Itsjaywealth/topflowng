/**
 * TopFlowNG — Rate limiters.
 *
 * Shared across routes. Windows and maxes come from config so operators can
 * tune them via environment variables without code changes.
 */

'use strict';

const rateLimit = require('express-rate-limit');

const config = require('../config');

function keyGeneratorIP(req) {
  return req.ip || req.connection?.remoteAddress || 'unknown';
}

function keyGeneratorUser(req) {
  return req.user ? `user:${req.user.id}` : keyGeneratorIP(req);
}

const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyGeneratorIP,
});

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  message: { error: 'Too many requests, slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyGeneratorIP,
});

// Per-user limiter for VTU purchases and wallet operations. Each authenticated
// user gets their own token bucket; unauthenticated requests fall back to IP.
const purchaseLimiter = rateLimit({
  windowMs: config.rateLimit.purchaseWindowMs,
  max: config.rateLimit.purchaseMax,
  message: { error: 'Too many purchase requests. Please wait before trying again.' },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: keyGeneratorUser,
});

module.exports = { authLimiter, apiLimiter, purchaseLimiter };
