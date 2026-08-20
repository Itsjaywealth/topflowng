'use strict';

const express = require('express');
const db = require('../database');
const { adminMiddleware } = require('../middleware/auth');
const { sendError } = require('../lib/errors');

const router = express.Router();

// Revenue trend: daily totals for the last 30 days
router.get('/revenue-trend', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await db.pool.query(`
      SELECT
        DATE(created_at) AS day,
        SUM(amount) FILTER (WHERE type = 'credit') AS credited,
        SUM(amount) FILTER (WHERE type = 'debit' AND status = 'completed') AS debited,
        COUNT(*) FILTER (WHERE type = 'debit') AS transactions,
        COUNT(*) FILTER (WHERE type = 'debit' AND status = 'completed') AS completed,
        COUNT(*) FILTER (WHERE type = 'debit' AND status = 'failed') AS failed
      FROM transactions
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
      LIMIT 30
    `);
    res.json({ days: rows });
  } catch (err) {
    sendError(res, 500, 'Failed to load revenue trend');
  }
});

// Top-selling products
router.get('/top-products', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await db.pool.query(`
      SELECT
        service_type,
        COUNT(*) AS count,
        SUM(amount) AS total,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed_count,
        SUM(amount) FILTER (WHERE status = 'completed') AS completed_total
      FROM vtu_orders
      WHERE created_at >= NOW() - INTERVAL '90 days'
      GROUP BY service_type
      ORDER BY count DESC
    `);
    res.json({ products: rows });
  } catch (err) {
    sendError(res, 500, 'Failed to load top products');
  }
});

// User growth
router.get('/user-growth', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await db.pool.query(`
      SELECT
        DATE(created_at) AS day,
        COUNT(*) AS new_users
      FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY day DESC
      LIMIT 30
    `);
    const total = await db.pool.query('SELECT COUNT(*)::int AS total FROM users');
    res.json({ days: rows, total: total.rows[0].total });
  } catch (err) {
    sendError(res, 500, 'Failed to load user growth');
  }
});

// Hourly activity (today)
router.get('/hourly-activity', adminMiddleware, async (req, res) => {
  try {
    const { rows } = await db.pool.query(`
      SELECT
        EXTRACT(HOUR FROM created_at)::int AS hour,
        COUNT(*) AS transactions,
        COUNT(*) FILTER (WHERE status = 'completed') AS completed
      FROM transactions
      WHERE created_at >= CURRENT_DATE
      GROUP BY EXTRACT(HOUR FROM created_at)
      ORDER BY hour
    `);
    res.json({ hours: rows });
  } catch (err) {
    sendError(res, 500, 'Failed to load hourly activity');
  }
});

module.exports = router;