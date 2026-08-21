/**
 * TopFlowNG — Direct pay-per-order routes (PAYMENT_MODE=direct).
 *
 * These routes create a specific TopFlowNG order and a Paystack checkout for
 * THAT order's server-calculated price. Payment is collected per order — the
 * customer does NOT fund a stored wallet. Once payment is verified server-side
 * (see the Paystack verify/webhook bridge), the order is fulfilled via VTPass.
 *
 * This module is only reachable/meaningful when PAYMENT_MODE=direct. The
 * existing wallet-mode purchase routes (/api/vtu/*) remain the active path in
 * wallet mode and are unchanged by this file.
 *
 * Security invariants:
 *   - The browser never sets the authoritative price; every amount is validated
 *     or recomputed server-side from the catalogue.
 *   - One payment reference maps to at most one order.
 */

'use strict';

const express = require('express');

const config = require('../config');
const db = require('../database');
const logger = require('../lib/logger');
const { authMiddleware } = require('../middleware/auth');
const { apiLimiter } = require('../middleware/rate-limit');
const { getPaymentProvider } = require('../payment');
const { sendError } = require('../lib/errors');
const { validate } = require('../lib/schemas');
const { normalizeNigerianPhone } = require('../lib/validate');
const {
  productFor, buildRequestId, VtpassProductError, MAX_PURCHASE_AMOUNT, parseValidatedAmount,
} = require('../services/vtpass');
const { validatePlanAmount, validateCablePlanAmount } = require('../services/pricing');

const router = express.Router();

// Reject direct-pay when the app is not configured for it. This makes it
// impossible to accidentally create wallet-free orders while production is in
// wallet mode.
function directModeGuard(req, res, next) {
  if (config.paymentMode !== 'direct') {
    return sendError(res, 403, 'Direct payment is not enabled for this deployment.');
  }
  next();
}

/**
 * POST /api/direct/orders
 * Body: { serviceType, ...details }
 * Creates a TopFlowNG order, validates server-side, initializes Paystack for
 * the authoritative price, and returns { authorization_url, reference }.
 * The order is created as payment_status='pending'.
 */
router.post('/orders', authMiddleware, apiLimiter, directModeGuard, validate(require('../lib/schemas').directOrderSchema), async (req, res) => {
  try {
    const { serviceType, ...details } = req.validated;

    // Build the authoritative product + price for the requested service.
    let product;
    let amount;
    switch (serviceType) {
      case 'airtime': {
        const network = String(details.network || '').toUpperCase();
        amount = parseValidatedAmount(details.amount);
        if (amount === null) return sendError(res, 400, `Amount must be a positive number up to ₦${MAX_PURCHASE_AMOUNT}`);
        product = productFor('airtime', { network, phone: normalizeNigerianPhone(details.phone), amount });
        break;
      }
      case 'data': {
        const network = String(details.network || '').toUpperCase();
        const plan = validatePlanAmount(network, details.planCode, details.amount);
        amount = plan.price;
        product = productFor('data', { network, phone: normalizeNigerianPhone(details.phone), planCode: plan.code });
        break;
      }
      case 'electricity': {
        const disco = String(details.disco || '').toUpperCase();
        amount = parseValidatedAmount(details.amount);
        if (amount === null) return sendError(res, 400, 'Invalid electricity amount');
        product = productFor('electricity', { disco, meterNumber: details.meterNumber, meterType: details.meterType, amount });
        break;
      }
      case 'cable': {
        const provider = String(details.provider || '').toUpperCase();
        const plan = validateCablePlanAmount(provider, details.planCode, details.amount);
        amount = plan.price;
        product = productFor('cable', { provider, smartCardNumber: details.smartCardNumber, planCode: plan.code });
        break;
      }
      case 'exam-pin': {
        const examBody = String(details.examBody || '').toUpperCase();
        const qty = details.quantity || 1;
        // Use the authoritative exam price from the pricing registry.
        const { findExamPrice } = require('../services/pricing');
        const unit = findExamPrice(examBody, details.examVariation);
        if (unit == null) return sendError(res, 400, 'This exam body is not currently available.');
        amount = parseFloat(unit) * qty;
        product = productFor('exam-pin', { examBody, examVariation: details.examVariation, quantity: qty, amount });
        break;
      }
      default:
        return sendError(res, 400, 'Unsupported service type');
    }

    // Create the direct order (payment_status='pending') and a Paystack checkout
    // tied to this exact order via its payment reference.
    const requestId = buildRequestId();
    const reference = `TF-${Date.now()}-${req.user.id}`;
    const description = directDescription(serviceType, details);

    await db.createDirectOrder({
      requestId, userId: req.user.id, serviceType, amount, description, paymentReference: reference,
      requestPayload: { serviceType, product, details },
    });

    const provider = getPaymentProvider();
    const user = await db.findUserById(req.user.id);
    const init = await provider.initializePayment({
      email: user.email,
      amount,
      reference,
      metadata: { user_id: req.user.id, order_request_id: requestId, direct: true },
      callbackUrl: `${config.appUrl}/?direct_verified=${reference}`,
    });

    logger.info('Direct order created awaiting payment', { requestId, reference, serviceType, amount });
    res.json({ authorization_url: init.authorizationUrl, reference, order_request_id: requestId, amount });
  } catch (err) {
    if (err instanceof VtpassProductError) return sendError(res, 400, err.message);
    // Catalog validation errors (unknown plan/bouquet, price mismatch) are
    // client errors, not server faults.
    if (err.statusCode === 400) return sendError(res, 400, err.message);
    logger.error('Direct order creation error', { message: err.response?.data ? JSON.stringify(err.response.data) : err.message });
    if (config.sentry.dsn) require('@sentry/node').captureException(err);
    sendError(res, 500, 'Could not create order');
  }
});

function directDescription(serviceType, d) {
  switch (serviceType) {
    case 'airtime': return `Airtime — ${d.network} ${d.phone}`;
    case 'data': return `Data — ${d.network} ${d.phone} (${d.planCode})`;
    case 'electricity': return `Electricity — ${d.disco} ${d.meterNumber}`;
    case 'cable': return `Cable — ${d.provider} ${d.smartCardNumber} (${d.planCode})`;
    case 'exam-pin': return `Exam PIN — ${d.examBody}`;
    default: return 'TopFlowNG order';
  }
}

module.exports = router;
