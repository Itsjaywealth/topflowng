'use strict';

/**
 * TopFlowNG — Outbound automation event bus.
 *
 * Emits domain events (transaction lifecycle, receipts, renewals, support,
 * BizFlowNG sync) into an immutable event log and delivers them to registered
 * webhook endpoints (n8n) with HMAC-SHA256 signatures.
 *
 * Guarantees:
 *   - At-least-once delivery per endpoint, with exponential backoff retries
 *     and a dead-letter state after the final attempt.
 *   - Idempotency: UNIQUE(endpoint_id, event_id) means a redelivery sweep can
 *     never duplicate a subscription row for the same event.
 *   - Replay protection for receivers: every request carries the unix timestamp
 *     and `v1=<hex(hmacSHA256(secret, "<ts>.<body>"))>` signature.
 *   - Payload hygiene: sensitive-looking fields (pins, tokens, passwords,
 *     API keys) are stripped recursively before persistence/delivery. Events
 *     carry references, never credentials or fulfilment codes.
 *
 * n8n (or any subscriber) can read but never mutate platform state: these
 * webhooks are fire-and-forget notifications. All financial mutations remain
 * behind authenticated TopFlowNG backend APIs.
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../lib/logger');

const RETRY_BACKOFF_MINUTES = [1, 5, 30, 120, 720]; // then dead-letter

// Keys whose values must never leave the platform (or hit the event log).
const SENSITIVE_KEY_RE = /pass(word)?|pin|token|secret|api[_-]?key|authorization|credential|cvv|card_number|otp/i;

function lazyDb() {
  // Lazy require avoids a circular import with database.js (which emits):
  // by the time this runs, the database module is fully initialised.
  return require('../database');
}

function newId() {
  return crypto.randomUUID();
}

/**
 * Recursively removes sensitive fields from an event payload.
 */
function sanitize(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => sanitize(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[redacted]';
      } else {
        out[k] = sanitize(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return value.slice(0, 500) + '…';
  return value;
}

/**
 * Computes the webhook signature headers for a raw body string.
 */
function signPayload(secret, rawBody, timestamp = Math.floor(Date.now() / 1000)) {
  const mac = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  return { timestamp, signature: `v1=${mac}` };
}

/** Constant-time signature check (used by tests and the verify helper). */
function verifySignature(secret, rawBody, timestamp, header) {
  if (typeof header !== 'string' || !header.startsWith('v1=')) return false;
  const expected = signPayload(secret, rawBody, Number(timestamp)).signature;
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function backoffMinutes(attempts) {
  return RETRY_BACKOFF_MINUTES[Math.min(attempts, RETRY_BACKOFF_MINUTES.length - 1)];
}

async function audit(action, { actorType = 'system', actorId = null, entityType = null, entityId = null, metadata = {}, ip = null } = {}) {
  try {
    const db = lazyDb();
    await db.pool.query(
      `INSERT INTO audit_log (actor_type, actor_id, action, entity_type, entity_id, metadata, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [actorType, actorId ? String(actorId) : null, action, entityType, entityId, JSON.stringify(sanitize(metadata)), ip]
    );
  } catch (err) {
    logger.warn('audit_log write failed', { action, message: err.message });
  }
}

/**
 * Emit a domain event. Persists it, fans out to matching active endpoints and
 * attempts first delivery asynchronously. Never throws — automation failures
 * must not break customer flows.
 */
async function emit(type, payload = {}, { entityType = null, entityId = null } = {}) {
  let eventId = null;
  try {
    const db = lazyDb();
    eventId = newId();
    const safePayload = sanitize(payload);
    await db.pool.query(
      `INSERT INTO automation_events (id, type, entity_type, entity_id, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, type, entityType, entityId, JSON.stringify(safePayload)]
    );
    const endpoints = await db.pool.query(
      `SELECT id, url, secret FROM webhook_endpoints
       WHERE active = TRUE AND (events = '{}' OR '*' = ANY(events) OR $1 = ANY(events))`,
      [type]
    );
    for (const ep of endpoints.rows) {
      await db.pool.query(
        `INSERT INTO webhook_deliveries (id, endpoint_id, event_id, status, next_retry_at)
         VALUES ($1, $2, $3, 'pending', NOW())
         ON CONFLICT (endpoint_id, event_id) DO NOTHING`,
        [newId(), ep.id, eventId]
      );
    }
    setImmediate(() => { processDeliveries(eventId).catch(() => {}); });
  } catch (err) {
    logger.warn('event emit failed', { type, message: err.message });
  }
  return eventId;
}

async function deliverOne(delivery, endpoint, event) {
  const db = lazyDb();
  const body = JSON.stringify({
    id: event.id,
    type: event.type,
    created_at: event.created_at,
    data: event.payload,
  });
  const { timestamp, signature } = signPayload(endpoint.secret, body);
  let statusCode = null;
  let errorText = null;
  try {
    const res = await axios.post(endpoint.url, body, {
      timeout: config.events.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-topflow-event-id': event.id,
        'x-topflow-event-type': event.type,
        'x-topflow-timestamp': String(timestamp),
        'x-topflow-signature': signature,
      },
      validateStatus: () => true,
      maxRedirects: 0,
    });
    statusCode = res.status;
    if (res.status < 200 || res.status >= 300) {
      errorText = `HTTP ${res.status}`;
    }
  } catch (err) {
    errorText = err.message || 'delivery error';
  }

  const delivered = errorText === null;
  const attempts = delivery.attempts + 1;
  if (delivered) {
    await db.pool.query(
      `UPDATE webhook_deliveries
       SET status = 'delivered', attempts = $2, last_status_code = $3,
           delivered_at = NOW(), next_retry_at = NULL, last_error = NULL
       WHERE id = $1`,
      [delivery.id, attempts, statusCode]
    );
  } else {
    const dead = attempts >= RETRY_BACKOFF_MINUTES.length;
    await db.pool.query(
      `UPDATE webhook_deliveries
       SET status = $2, attempts = $3, last_status_code = $4, last_error = $5,
           next_retry_at = CASE WHEN $2 = 'dead' THEN NULL ELSE NOW() + ($6 || ' minutes')::interval END
       WHERE id = $1`,
      [delivery.id, dead ? 'dead' : 'pending', attempts, statusCode, (errorText || '').slice(0, 400), String(backoffMinutes(attempts))]
    );
  }
  await audit(delivered ? 'webhook.delivered' : 'webhook.delivery_failed', {
    actorType: 'system',
    entityType: 'webhook_delivery',
    entityId: delivery.id,
    metadata: { event_id: event.id, event_type: event.type, endpoint: endpoint.name, attempts, status_code: statusCode, error: errorText },
  });
  return delivered;
}

/**
 * Attempt all due deliveries (optionally restricted to one event).
 */
async function processDeliveries(eventId = null) {
  const db = lazyDb();
  const params = [];
  let where;
  if (eventId) {
    // Immediate (first) attempt for a freshly emitted event: ignore backoff,
    // but never resurrect deliveries that already dead-lettered.
    params.push(eventId);
    where = `d.status = 'pending' AND d.event_id = $${params.length}`;
  } else {
    where = `d.status = 'pending' AND d.next_retry_at IS NOT NULL AND d.next_retry_at <= NOW()`;
  }
  const due = await db.pool.query(
    `SELECT d.id AS delivery_id, d.attempts, e.id, e.type, e.payload, e.created_at,
            w.id AS endpoint_id, w.url, w.secret, w.name
     FROM webhook_deliveries d
     JOIN automation_events e ON e.id = d.event_id
     JOIN webhook_endpoints w ON w.id = d.endpoint_id
     WHERE ${where}
     ORDER BY d.created_at
     LIMIT 50`,
    params
  );
  let ok = 0;
  for (const row of due.rows) {
    try {
      const delivered = await deliverOne(
        { id: row.delivery_id, attempts: row.attempts },
        { id: row.endpoint_id, url: row.url, secret: row.secret, name: row.name },
        { id: row.id, type: row.type, payload: row.payload, created_at: row.created_at }
      );
      if (delivered) ok += 1;
    } catch (err) {
      logger.warn('delivery attempt crashed', { message: err.message });
    }
  }
  return { attempted: due.rows.length, delivered: ok };
}

function startDeliverySweep(intervalMs = 60 * 1000) {
  const timer = setInterval(() => {
    processDeliveries().catch((err) => logger.warn('delivery sweep failed', { message: err.message }));
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = {
  emit,
  audit,
  sanitize,
  signPayload,
  verifySignature,
  processDeliveries,
  startDeliverySweep,
  RETRY_BACKOFF_MINUTES,
};
