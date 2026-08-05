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
const { sendPurchaseEmail } = require('../services/email');
const { sendError } = require('../lib/errors');
const Sentry = require('@sentry/node');

const router = express.Router();

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

// ── VTU — Airtime ────────────────────────────────────────────────────────────
router.post('/airtime', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { network, phone, amount, pin } = req.body;
    if (!network || !phone || !amount) return sendError(res, 400, 'network, phone, amount required');
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const ckNetwork = NETWORK_MAP[network.toUpperCase()];
    if (!ckNetwork) return sendError(res, 400, `Unsupported network: ${network}`);
    const requestId = `AIR-${Date.now()}-${req.user.id}`;

    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      MobileNetwork: ckNetwork,
      Amount: cost,
      MobileNumber: phone,
      RequestID: requestId,
      CallBackURL: '',
    };

    const desc = `${network} airtime — ${phone}`;
    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'airtime', amount: cost,
      description: desc, endpoint: config.clubkonnect.airtimeUrl, params,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Airtime', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      return res.json({ success: true, message: `₦${cost} ${network} airtime sent to ${phone}`, balance: result.balance, reference: requestId, orderId: result.orderId });
    }
    if (result.outcome === 'pending') return res.status(202).json({ pending: true, message: result.message, reference: requestId, orderId: result.orderId });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Airtime', err);
    sendError(res, 500, 'Airtime service unavailable');
  }
});

// ── VTU — Data Bundle ────────────────────────────────────────────────────────
router.post('/data', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { network, phone, planCode, amount, pin } = req.body;
    if (!network || !phone || !planCode || !amount) return sendError(res, 400, 'network, phone, planCode, amount required');
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const ckNetwork = NETWORK_MAP[network.toUpperCase()];
    if (!ckNetwork) return sendError(res, 400, `Unsupported network: ${network}`);

    const requestId = `DATA-${Date.now()}-${req.user.id}`;
    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      MobileNetwork: ckNetwork,
      DataPlan: planCode,
      MobileNumber: phone,
      RequestID: requestId,
      CallBackURL: '',
    };

    const desc = `${network} data ${planCode} — ${phone}`;
    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'data', amount: cost,
      description: desc, endpoint: config.clubkonnect.dataUrl, params,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Data', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      return res.json({ success: true, message: `Data bundle activated for ${phone}`, balance: result.balance, reference: requestId, orderId: result.orderId });
    }
    if (result.outcome === 'pending') return res.status(202).json({ pending: true, message: result.message, reference: requestId, orderId: result.orderId });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Data', err);
    sendError(res, 500, 'Data service unavailable');
  }
});

// ── VTU — Cable TV ───────────────────────────────────────────────────────────
router.post('/cable', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { provider, smartCardNumber, planCode, amount, pin } = req.body;
    if (!provider || !smartCardNumber || !planCode || !amount) return sendError(res, 400, 'provider, smartCardNumber, planCode, amount required');
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const requestId = `CABLE-${Date.now()}-${req.user.id}`;
    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      CableTV: provider.toUpperCase(),
      Package: planCode,
      SmartCardNo: smartCardNumber,
      RequestID: requestId,
      CallBackURL: '',
    };

    const desc = `${provider} ${planCode} — ${smartCardNumber}`;
    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'cable', amount: cost,
      description: desc, endpoint: config.clubkonnect.cableUrl, params,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Cable TV', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      return res.json({ success: true, message: `${provider} subscription activated`, balance: result.balance, reference: requestId, orderId: result.orderId });
    }
    if (result.outcome === 'pending') return res.status(202).json({ pending: true, message: result.message, reference: requestId, orderId: result.orderId });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Cable TV', err);
    sendError(res, 500, 'Cable TV service unavailable');
  }
});

// ── VTU — Electricity ────────────────────────────────────────────────────────
router.post('/electricity', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { disco, meterNumber, meterType, amount, pin } = req.body;
    if (!disco || !meterNumber || !meterType || !amount) return sendError(res, 400, 'disco, meterNumber, meterType, amount required');
    const cost = parseValidatedAmount(amount);
    if (cost === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
    await checkTransactionPin(req.user.id, pin);

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < cost) return sendError(res, 402, 'Insufficient wallet balance');

    const requestId = `ELEC-${Date.now()}-${req.user.id}`;
    const params = {
      UserID: config.clubkonnect.userId,
      APIKey: config.clubkonnect.apiKey,
      ElectricCompany: disco.toUpperCase(),
      MeterType: meterType.toUpperCase(),
      MeterNumber: meterNumber,
      Amount: cost,
      RequestID: requestId,
      CallBackURL: '',
    };

    const desc = `${disco} electricity — ${meterNumber}`;
    const result = await processClubkonnectPurchase({
      userId: req.user.id, requestId, serviceType: 'electricity', amount: cost,
      description: desc, endpoint: config.clubkonnect.electricityUrl, params,
    });
    if (result.outcome === 'success') {
      const user = await db.findUserById(req.user.id);
      sendPurchaseEmail(user.email, user.full_name, { service: 'Electricity', description: desc, amount: cost, reference: requestId, newBalance: result.balance });
      return res.json({ success: true, message: 'Electricity token sent', token: result.provider.raw.token || result.provider.raw.Token || '', balance: result.balance, reference: requestId, orderId: result.orderId });
    }
    if (result.outcome === 'pending') return res.status(202).json({ pending: true, message: result.message, reference: requestId, orderId: result.orderId });
    return sendError(res, 400, result.message, { reference: requestId, orderId: result.orderId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Electricity', err);
    sendError(res, 500, 'Electricity service unavailable');
  }
});

// ── Exam PIN ──────────────────────────────────────────────────────────────────
router.post('/exam-pin', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { examBody, quantity = 1, pin } = req.body;
    const ckBody = EXAM_BODY_MAP[examBody?.toUpperCase()];
    if (!ckBody) return sendError(res, 400, `Unsupported exam body: ${examBody}`);
    await checkTransactionPin(req.user.id, pin);
    const qty = Math.max(1, Math.min(5, parseInt(quantity) || 1));
    const amount = EXAM_PRICES[ckBody] * qty;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < amount) return sendError(res, 402, 'Insufficient wallet balance');

    const requestId = `EXAM-${Date.now()}-${req.user.id}`;
    const description = `${ckBody} exam PIN × ${qty}`;

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
      return res.json({ success: true, message: `${ckBody} PIN(s) purchased.`, pins: result.provider?.token || result.provider?.remark, balance: result.balance, reference: requestId });
    }
    if (result.outcome === 'pending') return res.status(202).json({ pending: true, message: result.message, reference: requestId, orderId: result.orderId });
    return sendError(res, 400, result.message, { reference: requestId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Exam PIN', err);
    sendError(res, 500, 'Exam PIN service error. Please try again.');
  }
});

// ── Recharge Card PIN ─────────────────────────────────────────────────────────
router.post('/recharge-pin', authMiddleware, apiLimiter, async (req, res) => {
  try {
    const { network, amount, quantity = 1, pin } = req.body;
    const ckNetwork = NETWORK_MAP[network?.toUpperCase()];
    if (!ckNetwork) return sendError(res, 400, `Unsupported network: ${network}`);
    await checkTransactionPin(req.user.id, pin);
    const qty = Math.max(1, Math.min(5, parseInt(quantity) || 1));
    const amt = parseValidatedAmount(amount);
    if (!amt || amt < 100) return sendError(res, 400, 'Amount must be a positive number of at least ₦100.');
    const totalAmount = amt * qty;

    const balance = await db.getWalletBalance(req.user.id);
    if (balance < totalAmount) return sendError(res, 402, 'Insufficient wallet balance');

    const requestId = `RPIN-${Date.now()}-${req.user.id}`;
    const description = `${network} recharge card ₦${amt} × ${qty}`;

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
      return res.json({ success: true, message: 'Recharge PIN(s) generated.', pins: result.provider?.token || result.provider?.remark, balance: result.balance, reference: requestId });
    }
    if (result.outcome === 'pending') return res.status(202).json({ pending: true, message: result.message, reference: requestId, orderId: result.orderId });
    return sendError(res, 400, result.message, { reference: requestId });
  } catch (err) {
    if (pinErrorResponse(err, res)) return;
    captureError('Recharge PIN', err);
    sendError(res, 500, 'Recharge PIN service error. Please try again.');
  }
});

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
