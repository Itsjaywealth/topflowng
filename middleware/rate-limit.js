/**
 * TopFlowNG — Rate limiters.
 *
 * Shared across routes. Windows and maxes come from config so operators can
 * tune them via environment variables without code changes.
 */

'use strict';

const rateLimit = require('express-rate-limit');

const config = require('../config');

const authLimiter = rateLimit({
  windowMs: config.rateLimit.authWindowMs,
  max: config.rateLimit.authMax,
  message: { error: 'Too many attempts, please try again in 15 minutes.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.apiWindowMs,
  max: config.rateLimit.apiMax,
  message: { error: 'Too many requests, slow down.' },
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, apiLimiter };
