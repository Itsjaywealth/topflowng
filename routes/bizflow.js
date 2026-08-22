'use strict';

/**
 * TopFlowNG — BizFlowNG account linking + expense sync API (customer-facing).
 *
 * A customer explicitly links their BizFlowNG business and explicitly opts
 * individual successful purchases in as business expenses. Nothing is synced
 * automatically; personal transactions are never pushed.
 */

const express = require('express');
const db = require('../database');
const config = require('../config');
const events = require('../services/events');
const bizflowSync = require('../services/bizflow-sync');
const { authMiddleware } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rate-limit');
const { sendError } = require('../lib/errors');
const logger = require('../lib/logger');

const router = express.Router();

// ── Link management ──────────────────────────────────────────────────────────
router.get('/link', authMiddleware, async (req, res) => {
  try {
    const link = await db.getBizflowLink(req.user.id);
    if (!link) return res.json({ ok: true, linked: false });
    res.json({
      ok: true,
      linked: true,
      business_id: link.bizflow_business_id,
      base_url: link.bizflow_base_url || config.bizflow.apiUrl || null,
      key_fingerprint: link.key_fingerprint,
      status: link.status,
      linked_at: link.linked_at,
      verified_at: link.verified_at,
    });
  } catch {
    sendError(res, 500, 'Failed to load BizFlowNG link');
  }
});

router.post('/link', authMiddleware, async (req, res) => {
  try {
    const { businessId, apiKey, baseUrl } = req.body || {};
    if (!businessId || !apiKey) return sendError(res, 400, 'businessId and apiKey are required');
    if (String(apiKey).length < 16) return sendError(res, 400, 'That API key looks too short to be valid');

    const effectiveBaseUrl = (baseUrl || config.bizflow.apiUrl || '').trim() || null;
    const verification = await bizflowSync.verifyLink({ baseUrl: effectiveBaseUrl, apiKey });
    const link = await db.upsertBizflowLink({
      userId: req.user.id,
      businessId: String(businessId).slice(0, 120),
      baseUrl: effectiveBaseUrl,
      apiKeyEnc: bizflowSync.encryptSecret(String(apiKey)),
      keyFingerprint: bizflowSync.fingerprint(String(apiKey)),
      status: verification.status,
    });
    await events.audit('bizflow.link.created', {
      actorType: 'customer', actorId: req.user.id,
      entityType: 'bizflow_link', entityId: link.id,
      metadata: { verified: verification.ok, detail: verification.detail },
      ip: req.ip,
    });
    if (verification.status === 'active') {
      await db.updateBizflowLinkStatus(req.user.id, 'active');
      await events.emit('topflow.bizflow.link.verified', { user_id: req.user.id }, { entityType: 'bizflow_link', entityId: link.id });
    }
    res.json({
      ok: true,
      status: verification.status,
      verified: verification.ok,
      detail: verification.detail,
      key_fingerprint: link.key_fingerprint,
    });
  } catch (err) {
    require('../lib/logger').warn('bizflow link failed', { message: err.message });
    sendError(res, 500, 'Failed to link BizFlowNG account');
  }
});

router.delete('/link', authMiddleware, async (req, res) => {
  try {
    await db.deleteBizflowLink(req.user.id);
    await events.audit('bizflow.link.deleted', {
      actorType: 'customer', actorId: req.user.id, entityType: 'bizflow_link', entityId: String(req.user.id), ip: req.ip,
    });
    res.json({ ok: true, linked: false });
  } catch {
    sendError(res, 500, 'Failed to unlink BizFlowNG account');
  }
});

// ── Expense sync opt-in ──────────────────────────────────────────────────────
// The customer picks a SUCCESSFUL transaction of theirs and pushes it as an
// expense candidate. Ownership, terminal success state and category are all
// re-verified server-side; the UNIQUE reference makes repeat calls no-ops.
router.post('/sync', authMiddleware, async (req, res) => {
  try {
    const reference = String((req.body || {}).reference || '').trim();
    const categoryOverride = String((req.body || {}).category || '').trim().toLowerCase();
    if (!reference) return sendError(res, 400, 'reference is required');

    const txn = await db.getRagTransactionByReference(req.user.id, reference);
    if (!txn) return sendError(res, 404, 'Transaction not found');
    if (txn.status !== 'completed') return sendError(res, 409, 'Only successful transactions can be synced');

    const approved = config.bizflowSyncCategories;
    let finalCategory = null;
    if (categoryOverride && approved.includes(categoryOverride)) finalCategory = categoryOverride;
    if (!finalCategory) {
      const st = (txn.service_type || '').toLowerCase();
      if (/electricity/.test(st)) finalCategory = 'electricity';
      else if (/airtime/.test(st)) finalCategory = 'airtime';
      else if (/data/.test(st)) finalCategory = 'data';
      else if (/cable|dstv|gotv|startimes/.test(st)) finalCategory = 'cable';
      else if (/exam|waec|jamb|neco|nabteb/.test(st)) finalCategory = 'exam-pin';
      else finalCategory = 'other';
    }
    if (!approved.includes(finalCategory)) return sendError(res, 400, 'Category not approved for expense sync');

    const link = await db.getBizflowLink(req.user.id);
    if (!link || !['active', 'unverified'].includes(link.status)) {
      return sendError(res, 409, 'Link your BizFlowNG account first');
    }

    const queued = await db.enqueueBizflowSync({
      userId: req.user.id,
      reference: txn.reference,
      category: finalCategory,
      amount: txn.amount,
      description: txn.description,
    });
    if (!queued) {
      return res.json({ ok: true, already_queued: true, reference: txn.reference });
    }
    await events.emit('topflow.bizflow.expense.queued', {
      user_id: req.user.id,
      reference: queued.reference,
      category: queued.category,
      amount: Number(queued.amount),
    }, { entityType: 'bizflow_sync', entityId: queued.reference });
    await events.audit('bizflow.sync.queued', {
      actorType: 'customer', actorId: req.user.id,
      entityType: 'bizflow_sync', entityId: queued.reference,
      metadata: { category: queued.category, amount: Number(queued.amount) },
      ip: req.ip,
    });
    setImmediate(() => { require('../services/bizflow-sync').processSyncQueue(5).catch(() => {}); });
    res.status(202).json({ ok: true, queued: true, sync: { reference: queued.reference, category: queued.category, amount: Number(queued.amount), status: queued.status } });
  } catch {
    sendError(res, 500, 'Failed to queue expense sync');
  }
});

// ── Order intents (business-initiated, user-confirmed) ──────────────────────
router.get('/intents', authMiddleware, async (req, res) => {
  try {
    const intents = await db.listPendingBizflowIntents(req.user.id);
    res.json({ ok: true, intents });
  } catch {
    sendError(res, 500, 'Failed to load business orders');
  }
});

router.post('/intents/:id/:decision(confirm|decline)', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { id, decision } = req.params;
    if (decision === 'decline') {
      const declined = await db.setBizflowIntentStatus(id, req.user.id, 'declined');
      if (!declined) return sendError(res, 404, 'Order request not found or already handled');
      await events.audit('bizflow.intent.declined', {
        actorType: 'customer', actorId: req.user.id,
        entityType: 'order_intent', entityId: id,
      });
      return res.json({ ok: true, status: 'declined' });
    }

    // Confirm: re-price server-side from the stored payload, create a real
    // direct order and hand back its secure checkout URL. No provider call and
    // no money movement happens here — payment completes at the provider.
    const intent = await db.getBizflowIntent(id);
    if (!intent || String(intent.user_id) !== String(req.user.id)) return sendError(res, 404, 'Order request not found');
    if (intent.status !== 'pending') return sendError(res, 409, 'This order request was already handled');

    const { productFor } = require('../services/vtpass');
    const d = (intent.request_payload && intent.request_payload.details) || {};
    const serviceType = intent.service_type;
    let product;
    switch (serviceType) {
      case 'airtime':
        product = productFor('airtime', { network: String(d.network || '').toUpperCase(), phone: d.phone, amount: parseFloat(intent.amount) });
        break;
      case 'data':
        product = productFor('data', { network: String(d.network || '').toUpperCase(), phone: d.phone, planCode: d.planCode });
        break;
      case 'electricity':
        product = productFor('electricity', { disco: String(d.disco || '').toUpperCase(), meterNumber: d.meterNumber, meterType: d.meterType || 'prepaid', amount: parseFloat(intent.amount) });
        break;
      case 'cable':
        product = productFor('cable', { provider: String(d.provider || '').toUpperCase(), smartCardNumber: d.smartCardNumber, planCode: d.planCode });
        break;
      case 'exam-pin':
        product = productFor('exam-pin', { examBody: String(d.examBody || '').toUpperCase(), examVariation: d.examVariation, quantity: d.quantity || 1, amount: parseFloat(intent.amount) });
        break;
      default:
        return sendError(res, 400, 'Unsupported service');
    }

    const requestId = require('../services/vtpass').buildRequestId();
    const reference = `TF-${Date.now()}-${req.user.id}`;
    await db.createDirectOrder({
      requestId, userId: req.user.id, serviceType,
      amount: parseFloat(intent.amount),
      description: `${intent.description} (via BizFlowNG)`,
      paymentReference: reference,
      requestPayload: { serviceType, product, details: d },
    });

    const provider = require('../payment').getPaymentProvider();
    const user = await db.findUserById(req.user.id);
    const init = await provider.initializePayment({
      email: user.email,
      amount: parseFloat(intent.amount),
      reference,
      metadata: { user_id: req.user.id, order_request_id: requestId, direct: true },
      callbackUrl: `${config.appUrl}/?direct_verified=${reference}`,
    });

    await db.setBizflowIntentStatus(id, req.user.id, 'confirmed', requestId);
    await events.audit('bizflow.intent.confirmed', {
      actorType: 'customer', actorId: req.user.id,
      entityType: 'order_intent', entityId: id,
      metadata: { requestId, amount: parseFloat(intent.amount) },
    });

    res.json({ ok: true, authorization_url: init.authorizationUrl, reference, request_id: requestId });
  } catch (err) {
    logger.error('Intent decision failed', { detail: err.message });
    sendError(res, 500, 'Could not process that order request');
  }
});

router.get('/syncs', authMiddleware, async (req, res) => {
  try {
    const rows = await db.getBizflowSyncsByUser(req.user.id);
    res.json({ ok: true, count: rows.length, syncs: rows });
  } catch {
    sendError(res, 500, 'Failed to load syncs');
  }
});

module.exports = router;
