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
    const customers = await db.getDormantCustomers({ days, limit });
    res.json({ ok: true, count: customers.length, dormant_after_days: days, customers });
  } catch {
    sendError(res, 500, 'Failed to load dormant customers');
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
