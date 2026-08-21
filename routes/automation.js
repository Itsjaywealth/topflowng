'use strict';

/**
 * TopFlowNG — Internal automation API (n8n / ops).
 *
 * All routes require the INTERNAL_API_KEY via the x-internal-key header.
 * Strictly read-only or subscription-management: nothing here can mutate
 * transaction state, provider order state, balances, ledger entries, refunds
 * or reconciliation outcomes. Financial mutations stay behind authenticated
 * customer/admin APIs only.
 */

const express = require('express');
const crypto = require('crypto');
const db = require('../database');
const config = require('../config');
const events = require('../services/events');
const { sendError } = require('../lib/errors');

function internalKeyMiddleware(req, res, next) {
  const key = req.headers['x-internal-key'] || '';
  if (!config.internalApiKey || key !== config.internalApiKey) {
    return sendError(res, 401, 'Invalid internal API key');
  }
  next();
}

const router = express.Router();
router.use(internalKeyMiddleware);

// ── Event log (pull-based fallback for subscribers) ─────────────────────────
// `?enrich=true` joins customer contact fields (email/full_name/phone) for
// events carrying user_id, so messaging workflows can address recipients
// without exposing any other customer data.
router.get('/events', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const enrich = req.query.enrich === 'true';
    const params = [];
    let where = 'TRUE';
    if (req.query.type) { params.push(String(req.query.type)); where += ` AND type = $${params.length}`; }
    if (req.query.since) { params.push(String(req.query.since)); where += ` AND created_at > $${params.length}::timestamptz`; }
    params.push(limit);
    const { rows } = await db.pool.query(
      `SELECT id, type, entity_type, entity_id, payload, created_at
       FROM automation_events WHERE ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
    if (enrich && rows.length > 0) {
      const userIds = [...new Set(rows.map((r) => r.payload && r.payload.user_id).filter(Boolean))];
      if (userIds.length > 0) {
        const u = await db.pool.query(
          'SELECT id, full_name, email, phone FROM users WHERE id = ANY($1::int[])',
          [userIds]
        );
        const byId = new Map(u.rows.map((r) => [r.id, r]));
        for (const row of rows) {
          const cust = row.payload && row.payload.user_id ? byId.get(row.payload.user_id) : null;
          row.customer = cust
            ? { user_id: cust.id, name: cust.full_name, email: cust.email, phone: cust.phone }
            : null;
        }
      }
    }
    res.json({ ok: true, count: rows.length, events: rows });
  } catch {
    sendError(res, 500, 'Failed to load events');
  }
});

// ── Renewal reminder bookkeeping ─────────────────────────────────────────────
// Marks a renewal as reminded so the daily feed stays idempotent.
router.post('/renewals/mark-reminded', async (req, res) => {
  try {
    const reference = String((req.body && req.body.reference) || '').slice(0, 64);
    if (!reference) return sendError(res, 400, 'reference is required');
    await db.markRenewalReminded(reference);
    return res.json({ ok: true, reference });
  } catch {
    sendError(res, 500, 'Failed to mark renewal reminded');
  }
});

// ── Webhook endpoint management ──────────────────────────────────────────────
router.get('/webhook-endpoints', async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT id, name, url, events, active,
              LEFT(secret, 3) || '…' AS secret_hint, created_at, updated_at
       FROM webhook_endpoints ORDER BY created_at DESC`
    );
    res.json({ ok: true, endpoints: rows });
  } catch {
    sendError(res, 500, 'Failed to load endpoints');
  }
});

router.post('/webhook-endpoints', async (req, res) => {
  try {
    const { name, url, secret, events: subscribed } = req.body || {};
    if (!name || !url) return sendError(res, 400, 'name and url are required');
    const isLocalHttp = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(String(url));
    if (!/^https:\/\//i.test(String(url)) && !isLocalHttp) return sendError(res, 400, 'url must be https');
    const endpointSecret = secret || crypto.randomBytes(24).toString('hex');
    const { rows } = await db.pool.query(
      `INSERT INTO webhook_endpoints (id, name, url, secret, events)
       VALUES ($1, $2, $3, $4, $5) RETURNING id, name, url, events, active, created_at`,
      [crypto.randomUUID(), String(name).slice(0, 100), String(url), endpointSecret, Array.isArray(subscribed) ? subscribed.map(String) : []]
    );
    await events.audit('webhook.endpoint.created', {
      actorType: 'automation', entityType: 'webhook_endpoint', entityId: rows[0].id,
      metadata: { name, url, events: subscribed || [] },
    });
    // Return the secret exactly once so the operator can store it in n8n.
    res.status(201).json({ ok: true, endpoint: rows[0], secret: endpointSecret });
  } catch (err) {
    require('../lib/logger').warn('webhook endpoint create failed', { message: err.message });
    sendError(res, 500, 'Failed to create endpoint');
  }
});

router.delete('/webhook-endpoints/:id', async (req, res) => {
  try {
    const { rowCount } = await db.pool.query('DELETE FROM webhook_endpoints WHERE id = $1', [req.params.id]);
    if (!rowCount) return sendError(res, 404, 'Endpoint not found');
    await events.audit('webhook.endpoint.deleted', { actorType: 'automation', entityType: 'webhook_endpoint', entityId: req.params.id });
    res.json({ ok: true });
  } catch {
    sendError(res, 500, 'Failed to delete endpoint');
  }
});

// Deliver a signed test event so operators can verify an n8n webhook end-to-end.
router.post('/webhook-endpoints/:id/test', async (req, res) => {
  try {
    const eventId = await events.emit('topflow.test.ping', { message: 'TopFlowNG webhook test', at: new Date().toISOString() }, { entityType: 'test' });
    res.json({ ok: true, event_id: eventId });
  } catch {
    sendError(res, 500, 'Failed to emit test event');
  }
});

// ── Transaction anomaly detection ────────────────────────────────────────────
// Compares the last hour against the 7-day hourly baseline. Read-only.
router.get('/anomalies', async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `
      WITH hourly AS (
        SELECT
          date_trunc('hour', updated_at) AS hr,
          COUNT(*) FILTER (WHERE status = 'failed')::int          AS failures,
          COUNT(*)::int                                            AS orders,
          (SELECT COALESCE(SUM(amount), 0) FROM transactions td
             JOIN vtu_orders o2 ON o2.transaction_id = td.id
             WHERE td.type = 'debit' AND td.status = 'completed'
               AND date_trunc('hour', td.created_at) = hr)         AS debit_volume
        FROM vtu_orders
        WHERE updated_at >= NOW() - interval '7 days'
        GROUP BY hr
      ),
      baseline AS (
        SELECT AVG(failures)::float AS avg_failures, AVG(orders)::float AS avg_orders,
               AVG(debit_volume)::float AS avg_debit_volume
        FROM hourly WHERE hr < date_trunc('hour', NOW())
      ),
      current_hour AS (
        SELECT
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failures,
          COUNT(*)::int AS orders,
          COUNT(*) FILTER (WHERE status IN ('submitted','pending'))::int AS stuck
        FROM vtu_orders
        WHERE updated_at >= date_trunc('hour', NOW())
           OR (status IN ('submitted','pending') AND updated_at > NOW() - interval '30 minutes')
      )
      SELECT c.failures, c.orders, c.stuck,
             COALESCE(b.avg_failures, 0) AS avg_failures,
             COALESCE(b.avg_orders, 0) AS avg_orders,
             COALESCE(b.avg_debit_volume, 0) AS avg_debit_volume
      FROM current_hour c CROSS JOIN baseline b
      `
    );
    const m = rows[0] || {};
    const anomalies = [];
    const failureThreshold = Math.max(Math.ceil((m.avg_failures || 0) * 3), 5);
    if ((m.failures || 0) >= failureThreshold) {
      anomalies.push({
        type: 'failure_spike',
        detail: `${m.failures} failed orders this hour (baseline avg ${Number(m.avg_failures || 0).toFixed(1)}/h, threshold ${failureThreshold})`,
        severity: 'high',
      });
    }
    if ((m.stuck || 0) >= 5) {
      anomalies.push({
        type: 'stuck_orders',
        detail: `${m.stuck} orders stuck in submitted/pending (threshold 5)`,
        severity: 'high',
      });
    }
    return res.json({
      ok: true,
      healthy: anomalies.length === 0,
      anomalies,
      metrics: {
        failures_this_hour: m.failures || 0,
        orders_this_hour: m.orders || 0,
        stuck_orders: m.stuck || 0,
        baseline_avg_failures: Number(m.avg_failures || 0).toFixed(2),
        baseline_avg_orders: Number(m.avg_orders || 0).toFixed(2),
      },
      generated_at: new Date().toISOString(),
    });
  } catch (err) {
    return sendError(res, 500, 'Failed to run anomaly detection');
  }
});

// ── Renewal reminders ────────────────────────────────────────────────────────
router.get('/renewals/upcoming', async (req, res) => {
  try {
    const windowDays = Math.min(parseInt(req.query.days) || config.events.renewalWindowDays, 30);
    const renewals = await db.getDueRenewals({ windowDays, limit: 200 });
    res.json({ ok: true, count: renewals.length, window_days: windowDays, renewals });
  } catch {
    sendError(res, 500, 'Failed to load renewals');
  }
});

// ── Dormant customers (reactivation) ────────────────────────────────────────
router.get('/customers/dormant', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days) || config.events.dormantDays, 365);
    const limit = Math.min(parseInt(req.query.limit) || config.events.dormantBatchLimit, 500);
    const optInOnly = req.query.opt_in_only === 'true';
    const customers = await db.getDormantCustomers({ days, limit, optInOnly });
    res.json({ ok: true, count: customers.length, dormant_after_days: days, customers });
  } catch {
    sendError(res, 500, 'Failed to load dormant customers');
  }
});

// ── Transaction lookup (read-only, for automation status checks) ────────────
router.get('/transactions/:reference', async (req, res) => {
  try {
    const { rows } = await db.pool.query(
      `SELECT o.request_id, o.user_id, o.service_type, o.amount, o.description,
              o.status, o.provider_order_id, o.created_at, o.updated_at,
              u.email AS user_email, u.full_name AS user_name
       FROM vtu_orders o JOIN users u ON u.id = o.user_id
       WHERE o.request_id = $1 LIMIT 1`,
      [String(req.params.reference).slice(0, 120)]
    );
    if (!rows.length) return sendError(res, 404, 'Transaction not found');
    const row = rows[0];
    res.json({
      ok: true,
      transaction: {
        reference: row.request_id,
        user_id: row.user_id,
        user_email: row.user_email,
        user_name: row.user_name,
        service_type: row.service_type,
        amount: Number(row.amount),
        description: row.description,
        status: row.status,
        provider_order_id: row.provider_order_id,
        created_at: row.created_at,
        updated_at: row.updated_at,
      },
    });
  } catch {
    sendError(res, 500, 'Failed to load transaction');
  }
});

// ── Renewal reminder bookkeeping ─────────────────────────────────────────────
router.post('/renewals/:reference/reminded', async (req, res) => {
  try {
    await db.markRenewalReminded(String(req.params.reference).slice(0, 120));
    await events.audit('renewal.reminder_sent', {
      actorType: 'automation', entityType: 'renewal_meta', entityId: String(req.params.reference).slice(0, 120),
    });
    res.json({ ok: true, reference: req.params.reference, reminded_at: new Date().toISOString() });
  } catch {
    sendError(res, 500, 'Failed to mark renewal reminded');
  }
});

// ── BizFlowNG sync queue (pull-based alternative for BizFlowNG/n8n) ─────────
router.get('/bizflow/syncs', async (req, res) => {
  try {
    const status = ['queued', 'synced', 'failed'].includes(req.query.status) ? req.query.status : null;
    const params = [];
    let where = 'TRUE';
    if (status) { params.push(status); where += ` AND s.status = $${params.length}`; }
    params.push(Math.min(parseInt(req.query.limit) || 50, 200));
    const { rows } = await db.pool.query(
      `SELECT s.reference, s.category, s.amount, s.description, s.status,
              s.bizflow_expense_id, s.created_at, s.synced_at,
              u.email AS customer_email
       FROM bizflow_syncs s JOIN users u ON u.id = s.user_id
       WHERE ${where} ORDER BY s.created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json({ ok: true, count: rows.length, syncs: rows });
  } catch {
    sendError(res, 500, 'Failed to load syncs');
  }
});

// ── Audit log tail ───────────────────────────────────────────────────────────
router.get('/audit', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 100, 500);
    const params = [];
    let where = 'TRUE';
    if (req.query.action) { params.push(String(req.query.action)); where += ` AND action = $${params.length}`; }
    params.push(limit);
    const { rows } = await db.pool.query(
      `SELECT id, actor_type, actor_id, action, entity_type, entity_id, metadata, ip, created_at
       FROM audit_log WHERE ${where} ORDER BY id DESC LIMIT $${params.length}`,
      params
    );
    res.json({ ok: true, count: rows.length, audit: rows });
  } catch {
    sendError(res, 500, 'Failed to load audit log');
  }
});

module.exports = { router, internalKeyMiddleware };
