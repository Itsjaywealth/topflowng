/**
 * TopFlowNG — VTU routes (Airtime, Data, Cable, Electricity, Exam PIN,
 * Recharge Card, Pending orders).
 *
 * Extracted from server.js without behaviour change. All provider interaction
 * goes through services/clubkonnect.js; rate limiting via shared middleware.
 */

'use strict';

const express = require('express');

const config = require('../config');
const db = require('../database');
const logger = require('../lib/logger');
const { authMiddleware, checkTransactionPin } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rate-limit');
const { processClubkonnectPurchase, MAX_PURCHASE_AMOUNT, parseValidatedAmount } = require('../services/clubkonnect');
const { validatePlanAmount, getCatalog } = require('../services/pricing');
const { sendPurchaseEmail } = require('../services/email');
const { resolveRequest, recordRequest } = require('../services/idempotency');
const { sendError } = require('../lib/errors');
const { validate, airtimeSchema, dataSchema, cableSchema, electricitySchema, examPinSchema, rechargePinSchema } = require('../lib/schemas');
const Sentry = require('@sentry/node');

const router = express.Router();

function withTracing(name, handler) {
  return async (req, res) => {
    if (!config.sentry.dsn) return handler(req, res);
    return Sentry.startSpan({ name, op: 'vtu.purchase' }, () => handler(req, res));
  };
}

const NETWORK_MAP = { MTN: '01', GLO: '02', '9MOBILE': '03', ETISALAT: '03', AIRTEL: '04' };
const EXAM_BODY_MAP = { WAEC: 'WAEC', NECO: 'NECO', NABTEB: 'NABTEB', JAMB: 'JAMB' };
const EXAM_PRICES = { WAEC: 3900, NECO: 1000, NABTEB: 1000, JAMB: 4700 };

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
  res.json(getCatalog());
});

// ── VTU — Pricing catalog (server-side) ────────────────────────────────────
router.get('/plans', (_req, res) => { res.json(getCatalog()); });

// ── VTU — Airtime ────────────────────────────────────────────────────────────
router.post('/airtime', authMiddleware, apiLimiter, validate(airtimeSchema), withTracing('vtu.airtime', async (req, res) => {
  try {
    const { network, phone, amount, pin } = req.validated;
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const ckNetwork = NETWORK_MAP[network.toUpperCase()];
    if (!ckNetwork) return sendError(res, 400, `Unsupported network: ${network}`);
    const desc = `${network} airtime — ${phone}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'airtime',
      payload: { network: ckNetwork, phone, amount: cost },
      amount: cost, description: desc,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : `AIR-${Date.now()}-${req.user.id}`;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      MobileNetwork: ckNetwork,
      Amount: cost,
      MobileNumber: phone,
      RequestID: requestId,
      CallBackURL: '',
    };

    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'airtime', amount: cost,
      description: desc, endpoint: config.clubkonnect.airtimeUrl, params,
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

    const ckNetwork = NETWORK_MAP[network.toUpperCase()];
    if (!ckNetwork) return sendError(res, 400, `Unsupported network: ${network}`);
    const desc = `${network} data ${planCode} — ${phone}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'data',
      payload: { network: ckNetwork, planCode, phone, amount: cost },
      amount: cost, description: desc,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : `DATA-${Date.now()}-${req.user.id}`;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      MobileNetwork: ckNetwork,
      DataPlan: planCode,
      MobileNumber: phone,
      RequestID: requestId,
      CallBackURL: '',
    };

    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'data', amount: cost,
      description: desc, endpoint: config.clubkonnect.dataUrl, params,
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
    const requestId = isIdempotent ? resolved.requestId : `CABLE-${Date.now()}-${req.user.id}`;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      CableTV: ckProvider,
      Package: planCode,
      SmartCardNo: smartCardNumber,
      RequestID: requestId,
      CallBackURL: '',
    };

    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'cable', amount: cost,
      description: desc, endpoint: config.clubkonnect.cableUrl, params,
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
    const requestId = isIdempotent ? resolved.requestId : `ELEC-${Date.now()}-${req.user.id}`;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      ElectricCompany: ckDisco,
      MeterType: ckMeterType,
      MeterNumber: meterNumber,
      Amount: cost,
      RequestID: requestId,
      CallBackURL: '',
    };

    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'electricity', amount: cost,
      description: desc, endpoint: config.clubkonnect.electricityUrl, params,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Electricity', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: 'Electricity token sent', token: result.provider.raw.token || result.provider.raw.Token || '', balance: result.balance, reference: requestId, orderId: result.orderId };
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
    const { examBody, quantity, pin } = req.validated;
    const ckBody = EXAM_BODY_MAP[examBody.toUpperCase()];
    await checkTransactionPin(req.user.id, pin);
    const qty = Math.max(1, Math.min(5, parseInt(quantity) || 1));
    const amount = EXAM_PRICES[ckBody] * qty;
    const description = `${ckBody} exam PIN × ${qty}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'exam-pin',
      payload: { examBody: ckBody, quantity: qty, amount },
      amount, description,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : `EXAM-${Date.now()}-${req.user.id}`;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < amount) return sendError(res, 402, 'Insufficient wallet balance');

    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'exam-pin', amount, description,
      endpoint: config.clubkonnect.examUrl,
      params: {
        UserID: config.clubkonnect.userId,
        APIKey: config.clubkonnect.apiKey,
        ExamBody: ckBody,
        Quantity: qty,
        RequestID: requestId,
      },
    });

    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Exam PIN', description, amount, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: `${ckBody} PIN(s) purchased.`, pins: result.provider?.token || result.provider?.remark, balance: result.balance, reference: requestId };
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
    const ckNetwork = NETWORK_MAP[network.toUpperCase()];
    if (!ckNetwork) return sendError(res, 400, `Unsupported network: ${network}`);
    await checkTransactionPin(req.user.id, pin);
    const qty = Math.max(1, Math.min(5, parseInt(quantity) || 1));
    const amt = parseValidatedAmount(amount);
    if (!amt || amt < 100) return sendError(res, 400, 'Amount must be a positive number of at least ₦100.');
    const totalAmount = amt * qty;
    const description = `${network} recharge card ₦${amt} × ${qty}`;

    const resolved = await resolveRequest({
      req, res, userId: req.user.id, serviceType: 'recharge-pin',
      payload: { network: ckNetwork, amount: amt, quantity: qty, totalAmount },
      amount: totalAmount, description,
    });
    if (resolved.kind === 'error' || resolved.kind === 'replay'
      || resolved.kind === 'conflict' || resolved.kind === 'in_progress') return;
    const isIdempotent = resolved.kind === 'proceed';
    const requestId = isIdempotent ? resolved.requestId : `RPIN-${Date.now()}-${req.user.id}`;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < totalAmount) return sendError(res, 402, 'Insufficient wallet balance');

    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'recharge-pin', amount: totalAmount, description,
      endpoint: config.clubkonnect.rechargeUrl,
      params: {
        UserID: config.clubkonnect.userId,
        APIKey: config.clubkonnect.apiKey,
        MobileNetwork: ckNetwork,
        Amount: amt,
        Quantity: qty,
        RequestID: requestId,
      },
    });

    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Recharge Card', description, amount: totalAmount, reference: requestId, newBalance: result.balance });
      const body = { success: true, message: 'Recharge PIN(s) generated.', pins: result.provider?.token || result.provider?.remark, balance: result.balance, reference: requestId };
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
