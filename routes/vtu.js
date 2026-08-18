/**
 * TopFlowNG — VTU routes (Airtime, Data, Cable, Electricity, Exam PIN,
 * Recharge Card, Pending orders).
 *
 * Extracted from server.js without behaviour change. All provider interaction
 * goes through services/vtpass.js; rate limiting via shared middleware.
 */

'use strict';

const express = require('express');

const config = require('../config');
const db = require('../database');
const logger = require('../lib/logger');
const { authMiddleware, checkTransactionPin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rate-limit');
const { processVtpassPurchase, productFor, getProductRegistry, buildRequestId, VtpassProductError, MAX_PURCHASE_AMOUNT, parseValidatedAmount } = require('../services/vtpass');
const {
  validatePlanAmount, validateCablePlanAmount, getCatalog,
  findExamPrice, ENABLED_EXAM_BODIES,
} = require('../services/pricing');
const { sendPurchaseEmail } = require('../services/email');
const { resolveRequest, recordRequest } = require('../services/idempotency');
const { sendError } = require('../lib/errors');
const { normalizeNigerianPhone } = require('../lib/validate');
const { validate, airtimeSchema, dataSchema, cableSchema, electricitySchema, examPinSchema, rechargePinSchema } = require('../lib/schemas');
const Sentry = require('@sentry/node');

const router = express.Router();

/**
 * Resolve the account holder's real phone number for provider requests that
 * require it (electricity, cable, recharge PIN).
 *
 * The JWT payload deliberately carries only { id, email } — it never contains
 * a phone claim — so `req.user.phone` is always undefined. Reading the phone
 * from the DB (users.phone is NOT NULL) and normalizing it to the
 * 0XXXXXXXXXX form VTPass accepts is the robust source of truth. Callers
 * fail closed when no valid number exists rather than sending an empty phone.
 */
async function resolveUserPhone(userId) {
  const user = await db.findUserById(userId);
  return user && user.phone ? normalizeNigerianPhone(user.phone) : '';
}

function withTracing(name, handler) {
  return async (req, res) => {
    if (!config.sentry.dsn) return handler(req, res);
    return Sentry.startSpan({ name, op: 'vtu.purchase' }, () => handler(req, res));
  };
}

// Exam bodies and prices come from the single pricing registry
// (services/pricing.js). Disabled bodies (NECO, NABTEB — not offered by the
// active provider) are absent from ENABLED_EXAM_BODIES, so they can never be
// quoted or charged here.

/**
 * Converts a VtpassProductError into a clean user-facing 400 response,
 * stripping all internal mapping keys, provider codes, and env-var references.
 */
function productErrorResponse(err, res) {
  if (err instanceof VtpassProductError) {
    const msg = err.message || '';
    let userMsg;
    if (msg.includes('is not mapped on the active provider') || msg.includes('are not mapped on the active provider')) {
      userMsg = 'This plan is temporarily unavailable. Please try another plan or contact support.';
    } else if (msg.includes('not yet configured on the active provider') || msg.includes('Configure it via VTPASS_PRODUCT_MAP')) {
      userMsg = 'Recharge card PINs are not yet available. Please check back soon.';
    } else if (msg.includes('are not available on the active provider')) {
      userMsg = msg.replace(/\s*Only [^.]+can be purchased\.?/gi, '').replace(/\s*\([^)]*\)/g, '').trim() || 'This exam body is not currently available. Please try WAEC or contact support.';
    } else if (msg.includes('Unsupported network:')) {
      userMsg = 'This network is not supported. Please select a different network.';
    } else if (msg.includes('Unsupported electricity provider:')) {
      userMsg = 'This electricity provider is not currently supported.';
    } else if (msg.includes('Unsupported meter type:')) {
      userMsg = 'This meter type is not supported. Please select Prepaid or Postpaid.';
    } else if (msg.includes('Unsupported service type:')) {
      userMsg = 'This service is not available at this time.';
    } else {
      userMsg = msg.replace(/\s*\([^)]*\)/g, '').trim();
    }
    res.status(400).json({ error: userMsg || 'This service is temporarily unavailable. Please try again.' });
    return true;
  }
  return false;
}

function pinErrorResponse(err, res) {
  if (err.code === 'PIN_REQUIRED') {
    res.status(400).json({ error: 'Transaction PIN required', pinRequired: true });
    return true;
  }
  if (err.code === 'PIN_INVALID') {
    res.status(401).json({ error: 'Incorrect transaction PIN' });
    return true;
  }
  return false;
}

function captureError(service, err) {
  logger.error(`${service} error`, { message: err.message });
  if (config.sentry.dsn) Sentry.captureException(err);
}

// ── VTU — Pricing catalog (server-side source of truth) ─────────────────────
router.get('/plans', (_req, res) => {
  res.json({ ...getCatalog(), productRegistry: getProductRegistry() });
});

// ── VTU — Airtime ────────────────────────────────────────────────────────────
router.post('/airtime', authMiddleware, apiLimiter, validate(airtimeSchema), withTracing('vtu.airtime', async (req, res) => {
  try {
    const { network, phone, amount, pin } = req.validated;
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const desc = `${network} airtime — ${phone}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'airtime',
      payload: { network: network.toUpperCase(), phone, amount: cost },
      amount: cost, description: desc,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : buildRequestId();

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const product = productFor('airtime', { network, phone, amount: cost });

    const result = await processVtpassPurchase({
      userId: req.user.id, requestId, serviceType: 'airtime', amount: cost,
      description: desc, product,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Airtime', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: `₦${cost} ${network} airtime sent to ${phone}`, balance: result.balance, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 200, body, isIdempotent });
      return res.json(body);
    }
    if (result.outcome === 'pending') {
      const body = { pending: true, message: result.message, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 202, body, isIdempotent });
      return res.status(202).json(body);
    }
    const body = { error: result.message, reference: requestId, orderId: result.orderId };
    await recordRequest({ requestId, statusCode: 400, body, isIdempotent });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Airtime', err);
    sendError(res, 500, 'Airtime service unavailable');
  }
}));

// ── VTU — Data Bundle ────────────────────────────────────────────────────────
router.post('/data', authMiddleware, apiLimiter, validate(dataSchema), withTracing('vtu.data', async (req, res) => {
  try {
    const { network, phone, planCode, amount, pin } = req.validated;
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);
    try { validatePlanAmount(network, planCode, cost); } catch (e) { return sendError(res, 400, e.message); }

    const desc = `${network} data ${planCode} — ${phone}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'data',
      payload: { network: network.toUpperCase(), planCode, phone, amount: cost },
      amount: cost, description: desc,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : buildRequestId();

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    let product;
    try {
      product = productFor('data', { network, planCode, phone });
    } catch (err) {
      if (productErrorResponse(err, res)) return;
      throw err;
    }

    const result = await processVtpassPurchase({
      userId: req.user.id, requestId, serviceType: 'data', amount: cost,
      description: desc, product,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Data', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: `Data bundle activated for ${phone}`, balance: result.balance, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 200, body, isIdempotent });
      return res.json(body);
    }
    if (result.outcome === 'pending') {
      const body = { pending: true, message: result.message, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 202, body, isIdempotent });
      return res.status(202).json(body);
    }
    const body = { error: result.message, reference: requestId, orderId: result.orderId };
    await recordRequest({ requestId, statusCode: 400, body, isIdempotent });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Data', err);
    sendError(res, 500, 'Data service unavailable');
  }
}));

// ── VTU — Cable TV ───────────────────────────────────────────────────────────
router.post('/cable', authMiddleware, apiLimiter, validate(cableSchema), withTracing('vtu.cable', async (req, res) => {
  try {
    const { provider, smartCardNumber, planCode, amount, pin } = req.validated;
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);
    // The server — never the client — decides what a bouquet costs. Without
    // this the client could ask for a ₦24,200 package at a ₦100 amount and the
    // wallet would only be debited ₦100 on delivery.
    try { validateCablePlanAmount(provider, planCode, cost); } catch (e) { return sendError(res, 400, e.message); }

    const ckProvider = provider.toUpperCase();
    const desc = `${provider} ${planCode} — ${smartCardNumber}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'cable',
      payload: { provider: ckProvider, planCode, smartCardNumber, amount: cost },
      amount: cost, description: desc,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : buildRequestId();

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    let product;
    try {
      product = productFor('cable', {
        provider: ckProvider, planCode, smartCardNumber,
        phone: await resolveUserPhone(req.user.id),
      });
    } catch (err) {
      if (productErrorResponse(err, res)) return;
      throw err;
    }

    const result = await processVtpassPurchase({
      userId: req.user.id, requestId, serviceType: 'cable', amount: cost,
      description: desc, product,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Cable TV', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: `${provider} subscription activated`, balance: result.balance, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 200, body, isIdempotent });
      return res.json(body);
    }
    if (result.outcome === 'pending') {
      const body = { pending: true, message: result.message, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 202, body, isIdempotent });
      return res.status(202).json(body);
    }
    const body = { error: result.message, reference: requestId, orderId: result.orderId };
    await recordRequest({ requestId, statusCode: 400, body, isIdempotent });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Cable TV', err);
    sendError(res, 500, 'Cable TV service unavailable');
  }
}));

// ── VTU — Electricity ────────────────────────────────────────────────────────
router.post('/electricity', authMiddleware, apiLimiter, validate(electricitySchema), withTracing('vtu.electricity', async (req, res) => {
  try {
    const { disco, meterNumber, meterType, amount, pin } = req.validated;
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const ckDisco = disco.toUpperCase();
    const ckMeterType = meterType.toUpperCase();
    const desc = `${disco} electricity — ${meterNumber}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'electricity',
      payload: { disco: ckDisco, meterNumber, meterType: ckMeterType, amount: cost },
      amount: cost, description: desc,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : buildRequestId();

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    let product;
    try {
      product = productFor('electricity', {
        disco: ckDisco, meterType, meterNumber, amount: cost,
        phone: await resolveUserPhone(req.user.id),
      });
    } catch (err) {
      if (productErrorResponse(err, res)) return;
      throw err;
    }

    const result = await processVtpassPurchase({
      userId: req.user.id, requestId, serviceType: 'electricity', amount: cost,
      description: desc, product,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Electricity', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: 'Electricity token sent', token: result.provider?.token || result.provider?.purchasedCode || '', balance: result.balance, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 200, body, isIdempotent });
      return res.json(body);
    }
    if (result.outcome === 'pending') {
      const body = { pending: true, message: result.message, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 202, body, isIdempotent });
      return res.status(202).json(body);
    }
    const body = { error: result.message, reference: requestId, orderId: result.orderId };
    await recordRequest({ requestId, statusCode: 400, body, isIdempotent });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Electricity', err);
    sendError(res, 500, 'Electricity service unavailable');
  }
}));

// ── Exam PIN ──────────────────────────────────────────────────────────────────
router.post('/exam-pin', authMiddleware, apiLimiter, validate(examPinSchema), withTracing('vtu.exam-pin', async (req, res) => {
  try {
    const { examBody, examVariation, quantity, pin } = req.validated;
    const ckBody = String(examBody || '').toUpperCase();
    // Fail closed on any body that is not verified AND enabled in the pricing
    // registry — this is what keeps NECO/NABTEB unpurchasable end to end.
    if (!ENABLED_EXAM_BODIES.includes(ckBody)) {
      return sendError(res, 400, `${ckBody} exam PINs are not available yet. Available: ${ENABLED_EXAM_BODIES.join(', ')}.`);
    }
    await checkTransactionPin(req.user.id, pin);
    const qty = Math.max(1, Math.min(5, parseInt(quantity) || 1));
    const unitPrice = findExamPrice(ckBody, examVariation);
    if (!unitPrice) return sendError(res, 400, 'Invalid exam body or variation selected.');
    const amount = unitPrice * qty;
    const description = `${ckBody} exam PIN × ${qty}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'exam-pin',
      payload: { examBody: ckBody, quantity: qty, amount },
      amount, description,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : buildRequestId();

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < amount) return sendError(res, 402, 'Insufficient wallet balance');

    let product;
    try {
      product = productFor('exam-pin', { examBody: ckBody, quantity: qty, examVariation: examVariation || undefined });
    } catch (err) {
      if (productErrorResponse(err, res)) return;
      throw err;
    }

    const result = await processVtpassPurchase({
      userId: req.user.id, requestId, serviceType: 'exam-pin', amount, description,
      product,
    });

    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Exam PIN', description, amount, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: `${ckBody} PIN(s) purchased.`, pins: result.provider?.purchasedCode || result.provider?.token || result.provider?.remark, balance: result.balance, reference: requestId };
      await recordRequest({ requestId, statusCode: 200, body, isIdempotent });
      return res.json(body);
    }
    if (result.outcome === 'pending') {
      const body = { pending: true, message: result.message, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 202, body, isIdempotent });
      return res.status(202).json(body);
    }
    const body = { error: result.message, reference: requestId };
    await recordRequest({ requestId, statusCode: 400, body, isIdempotent });
    return sendError(res, 400, result.message, { reference: requestId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Exam PIN', err);
    sendError(res, 500, 'Exam PIN service error. Please try again.');
  }
}));

// ── Recharge Card PIN ─────────────────────────────────────────────────────────
router.post('/recharge-pin', authMiddleware, apiLimiter, validate(rechargePinSchema), withTracing('vtu.recharge-pin', async (req, res) => {
  try {
    const { network, amount, quantity, pin } = req.validated;
    await checkTransactionPin(req.user.id, pin);
    const qty = Math.max(1, Math.min(5, parseInt(quantity) || 1));
    const amt = parseValidatedAmount(amount);
    if (!amt || amt < 100) return sendError(res, 400, 'Amount must be a positive number of at least ₦100.');
    const totalAmount = amt * qty;
    const description = `${network} recharge card ₦${amt} × ${qty}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'recharge-pin',
      payload: { network: network.toUpperCase(), amount: amt, quantity: qty, totalAmount },
      amount: totalAmount, description,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : buildRequestId();

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < totalAmount) return sendError(res, 402, 'Insufficient wallet balance');

    let product;
    try {
      product = productFor('recharge-pin', {
        network, amount: amt, quantity: qty,
        phone: await resolveUserPhone(req.user.id),
      });
    } catch (err) {
      if (productErrorResponse(err, res)) return;
      throw err;
    }

    const result = await processVtpassPurchase({
      userId: req.user.id, requestId, serviceType: 'recharge-pin', amount: totalAmount, description,
      product,
    });

    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Recharge Card', description, amount: totalAmount, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: 'Recharge PIN(s) generated.', pins: result.provider?.purchasedCode || result.provider?.token || result.provider?.remark, balance: result.balance, reference: requestId };
      await recordRequest({ requestId, statusCode: 200, body, isIdempotent });
      return res.json(body);
    }
    if (result.outcome === 'pending') {
      const body = { pending: true, message: result.message, reference: requestId, orderId: result.orderId };
      await recordRequest({ requestId, statusCode: 202, body, isIdempotent });
      return res.status(202).json(body);
    }
    const body = { error: result.message, reference: requestId };
    await recordRequest({ requestId, statusCode: 400, body, isIdempotent });
    return sendError(res, 400, result.message, { reference: requestId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Recharge PIN', err);
    sendError(res, 500, 'Recharge PIN service error. Please try again.');
  }
}));

// ── Pending VTU Orders ───────────────────────────────────────────────────────
router.get('/pending', authMiddleware, async (req, res) => {
  try {
    const orders = await db.getPendingVtuOrders(req.user.id);
    res.json({ hasPending: orders.length > 0, orders });
  } catch (err) {
    captureError('Pending orders', err);
    sendError(res, 500, 'Failed to check pending orders');
  }
});

module.exports = router;
