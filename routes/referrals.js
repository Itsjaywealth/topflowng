'use strict';

/**
 * TopFlowNG — Referral campaign feed (internal, read-only).
 *
 * Segments for the growth messaging layer:
 *  - has_code_no_referrals: established users whose referral code has never
 *    been used (nudge to share).
 *  - top_referrers: users with >= minReferrals successful referrals (thank-you).
 * Auth: x-internal-key. Read-only.
 */

const express = require('express');
const db = require('../database');
const config = require('../config');
const { sendError } = require('../lib/errors');

const router = express.Router();

function internalKeyMiddleware(req, res, next) {
  const key = req.headers['x-internal-key'] || '';
  if (!config.internalApiKey || key !== config.internalApiKey) {
    return sendError(res, 401, 'Invalid internal API key');
  }
  next();
}

router.use(internalKeyMiddleware);

/**
 * GET /api/internal/referrals/campaign?minReferrals=3&activeDays=60&limit=100
 */
router.get('/campaign', async (req, res) => {
  try {
    const minReferrals = Math.min(parseInt(req.query.minReferrals, 10) || 3, 50);
    const activeDays = Math.min(parseInt(req.query.activeDays, 10) || 60, 365);
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);

    // Established users with an unused code and recent purchase activity.
    const { rows: nudges } = await db.pool.query(
      `
      SELECT u.id, u.full_name, u.email, u.referral_code, u.marketing_opt_in,
             MAX(t.created_at)::text AS last_activity
      FROM users u
      LEFT JOIN transactions t ON t.user_id = u.id AND t.type = 'debit' AND t.status = 'completed'
      WHERE u.referral_code IS NOT NULL
        AND u.created_at < NOW() - interval '14 days'
        AND u.email LIKE '%@%'
        AND COALESCE((SELECT COUNT(*)::int FROM users r2 WHERE r2.referred_by = u.id), 0) = 0
      GROUP BY u.id, u.full_name, u.email, u.referral_code
      HAVING MAX(t.created_at) > NOW() - $1::int * interval '1 day'
      ORDER BY MAX(t.created_at) DESC NULLS LAST
      LIMIT $2
      `,
      [activeDays, limit]
    );

    // Users whose code has been used by at least minReferrals signups.
    const { rows: top } = await db.pool.query(
      `
      SELECT u.id, u.full_name, u.email, u.referral_code, u.marketing_opt_in,
             COUNT(r2.id)::int AS total_referrals
      FROM users u
      JOIN users r2 ON r2.referred_by = u.id
      WHERE u.referral_code IS NOT NULL AND u.email LIKE '%@%'
      GROUP BY u.id, u.full_name, u.email, u.referral_code
      HAVING COUNT(r2.id) >= $1
      ORDER BY total_referrals DESC
      LIMIT $2
      `,
      [minReferrals, limit]
    );

    return res.json({
      ok: true,
      segments: {
        has_code_no_referrals: {
          count: nudges.length,
          users: nudges.map((r) => ({
            user_id: r.id,
            name: r.full_name,
            email: r.email,
            referral_code: r.referral_code,
            marketing_opt_in: Boolean(r.marketing_opt_in),
            last_activity: r.last_activity,
          })),
        },
        top_referrers: {
          count: top.length,
          users: top.map((r) => ({
            user_id: r.id,
            name: r.full_name,
            email: r.email,
            referral_code: r.referral_code,
            marketing_opt_in: Boolean(r.marketing_opt_in),
            total_referrals: r.total_referrals,
          })),
        },
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to build referral campaign feed');
  }
});

module.exports = { router, internalKeyMiddleware };
