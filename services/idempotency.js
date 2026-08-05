/**
 * TopFlowNG — VTU purchase idempotency (Phase 4D).
 *
 * Centralises idempotency logic for the VTU purchase routes. A client may send
 * an `Idempotency-Key` header; the key, together with the authenticated user
 * and the (normalised) route payload, determines a stable request id and a
 * deterministic cryptographic fingerprint. The first request reserves the slot
 * on `vtu_orders` atomically (migration 001 partial unique index); any retry
 * with the same key+user+payload returns the stored safe response without ever
 * re-contacting the provider or re-debiting the wallet. Requests with the same
 * key but a different payload are rejected with 409.
 *
 * Requests WITHOUT an `Idempotency-Key` are untouched (legacy behaviour).
 *
 * The stored `response_snapshot` deliberately contains only the public,
 * response-shaped fields (never the raw provider body, tokens, pins, or keys).
 */

'use strict';

const crypto = require('crypto');

const db = require('../database');
const logger = require('../lib/logger');
const { sendError } = require('../lib/errors');

const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]+$/;

// ── Key input ────────────────────────────────────────────────────────────────
// Reads the Idempotency-Key request header (case-insensitive) for the VTU
// routes. Returns null when the header is absent (legacy request). Throws a
// proper 400 status via sendError on empty / malformed / oversized keys.
function readIdempotencyKey(req) {
  const raw = req.get('Idempotency-Key');
  if (raw === undefined || raw === null) return null;
  const key = String(raw).trim();
  if (key.length === 0) {
    return { error: true };
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH
    || !IDEMPOTENCY_KEY_PATTERN.test(key)) {
    return { error: true };
  }
  return key;
}

// Stable, user-scoped request id derived from the idempotency key. Scoping by
// user means two different users may legitimately reuse the same client key
// without colliding on the globally-unique vtu_orders.request_id.
function requestIdFromKey(userId, idempotencyKey) {
  const hash = crypto.createHash('sha256').update(`${userId}:${idempotencyKey}`).digest('hex');
  return `IDP-${String(userId)}-${hash.slice(0, 16)}`;
}

// Deterministic cryptographic fingerprint of the request. `payload` must be a
// stable, normalised object (no timestamps, no volatile values). Keys are
// sorted so field order never changes the fingerprint.
function buildFingerprint({ userId, serviceType, payload }) {
  const canonical = JSON.stringify({ userId, serviceType, payload });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

// Safe snapshot: only the shape we are willing to echo back on a replay.
function buildSnapshot(statusCode, body) {
  return {
    statusCode,
    body: {
      success: body.success === true,
      pending: body.pending === true,
      message: body.message,
      reference: body.reference,
      orderId: body.orderId,
      balance: typeof body.balance === 'number' ? body.balance : undefined,
    },
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────
// Resolves an idempotent VTU purchase request.
//
// Returns:
//   { kind: 'proceed', requestId }        → caller should run the real purchase
//   { kind: 'replay',   statusCode, body } → return stored response directly
//   { kind: 'conflict'                    } → already used with a different payload
//   { kind: 'in_progress' }               → same key already processing
//   { kind: 'error', statusCode, body }   → invalid key (already sent)
//   { kind: 'legacy' }                    → no Idempotency-Key, run as before
async function resolve({
  req, res, userId, serviceType, payload, amount, description,
}) {
  const key = readIdempotencyKey(req);
  if (key === null) return { kind: 'legacy' };
  if (key.error) {
    sendError(res, 400, 'Invalid Idempotency-Key header');
    return { kind: 'error', statusCode: 400 };
  }

  const fingerprint = buildFingerprint({ userId, serviceType, payload });
  const requestId = requestIdFromKey(userId, key);

  const { claimed, order } = await db.acquireVtuIdempotency({
    requestId,
    userId,
    serviceType,
    amount,
    description,
    idempotencyKey: key,
    requestFingerprint: fingerprint,
  });

  if (claimed) {
    logger.debug('VTU idempotency: claimed new slot', { requestId });
    return { kind: 'proceed', requestId, fingerprint };
  }

  // Existing reservation for this key. Compare fingerprint.
  if (order && order.request_fingerprint !== fingerprint) {
    sendError(res, 409, 'Idempotency key already used with a different request');
    return { kind: 'conflict', statusCode: 409 };
  }

  if (order && order.response_snapshot) {
    const snap = order.response_snapshot;
    const statusCode = snap.statusCode && snap.statusCode >= 100 && snap.statusCode <= 599
      ? snap.statusCode
      : 200;
    res.status(statusCode).json(snap.body);
    return { kind: 'replay', statusCode };
  }

  // Reserved but the original request has not yet reached a terminal state.
  res.status(202).json({
    pending: true,
    message: 'This request is already being processed. It has not been debited again.',
    reference: requestId,
  });
  return { kind: 'in_progress', statusCode: 202 };
}

// Records the safe response snapshot after a successful run, so an exact retry
// can replay it without re-running the purchase. No-op for legacy requests.
async function record({ requestId, statusCode, body, isIdempotent }) {
  if (!isIdempotent) return;
  await db.recordVtuIdempotencyResult(requestId, buildSnapshot(statusCode, body));
}

module.exports = {
  MAX_IDEMPOTENCY_KEY_LENGTH,
  readIdempotencyKey,
  requestIdFromKey,
  buildFingerprint,
  resolveRequest: resolve,
  recordRequest: record,
};