'use strict';

/**
 * TopFlowNG — BizFlowNG → TopFlowNG business ordering API.
 *
 * Mounted at /api/integrations/topflowng. A linked BizFlowNG business may:
 *   GET  /services        — read-only catalogue of ACTIVE customer-facing services
 *   POST /order-intents   — propose a VTU order for its linked user
 *   GET  /order-intents/:id — read one intent's state
 *
 * Security:
 *   - Authenticated by the SAME per-business integration key the expense
 *     receiver uses: `x-bizflow-key` + HMAC-SHA256 signature
 *     (`x-topflow-timestamp`, `x-topflow-signature: v1=<hex>` over
 *     "<timestamp>.<rawBody>"), replay-guarded (±5 min).
 *   - The key must match the stored (encrypted) key of an ACTIVE TopFlowNG↔
 *     BizFlowNG link; requests only ever reach that link's user.
 *   - The caller never sets prices or provider variation codes — every amount
 *     is recomputed server-side from the catalogue. An intent alone moves no
 *     money and contacts no provider; the user explicitly confirms first.
 */

const express = require('express');
const crypto = require('crypto');

const db = require('../database');
const config = require('../config');
const logger = require('../lib/logger');
const { sendError } = require('../lib/errors');
const { DATA_PLANS, CABLE_PLANS, EXAM_PRICES, ENABLED_EXAM_BODIES } = require('../services/pricing');
const vtpassSvc = require('../services/vtpass');
const { PRODUCT_MAP = {} } = vtpassSvc;
const { MAX_PURCHASE_AMOUNT, parseValidatedAmount } = vtpassSvc;
const bizflowSync = require('../services/bizflow-sync');

const router = express.Router();

// ── Signature auth ───────────────────────────────────────────────────────────
async function authenticateBizflow(req, res) {
  const key = req.headers['x-bizflow-key'] || '';
  const ts = req.headers['x-topflow-timestamp'] || '';
  const sig = req.headers['x-topflow-signature'] || '';
  if (!key || String(key).length < 24) {
    sendError(res, 401, 'Invalid integration key');
    return null;
  }
  const skew = Math.abs(Math.floor(Date.now() / 1000) - Number(ts));
  if (!ts || !Number.isFinite(skew) || skew > 300) {
    sendError(res, 401, 'Stale timestamp');
    return null;
  }
  let businessId = null;
  try {
    const parsed = JSON.parse(req.rawBody || '{}');
    businessId = parsed.business_id || null;
  } catch { /* fall through to query param */ }
  if (!businessId) businessId = req.query.business_id || null;
  if (!businessId) {
    sendError(res, 400, 'business_id is required');
    return null;
  }
  const link = await db.getBizflowLinkByBusiness(String(businessId));
  if (!link || link.status !== 'active' || !link.api_key_enc) {
    sendError(res, 403, 'No active TopFlowNG link for this business');
    return null;
  }
  const apiKey = bizflowSync.decryptSecret(link.api_key_enc);
  if (!apiKey || apiKey !== String(key)) {
    sendError(res, 401, 'Invalid integration key');
    return null;
  }
  const expected = crypto.createHmac('sha256', apiKey).update(`${ts}.${req.rawBody || ''}`).digest('hex');
  const got = String(sig).replace(/^v1=/, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(got);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    sendError(res, 401, 'Invalid signature');
    return null;
  }
  return { link, businessId: String(businessId), userId: link.user_id };
}

router.use((req, res, next) => {
  // express.raw (mounted pre-JSON in server.js) leaves the exact request
  // bytes on req.body as a Buffer.
  req.rawBody = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '';
  next();
});

// ── Catalogue ────────────────────────────────────────────────────────────────
router.get('/services', async (req, res) => {
  const auth = await authenticateBizflow(req, res);
  if (!auth) return;
  try {
    const data = [];
    // Airtime
    data.push({
      category: 'airtime',
      products: ['MTN', 'GLO', 'AIRTEL', '9MOBILE'].map((network) => ({
        provider: network,
        price: null,
        availability: 'available',
        fields: [
          { name: 'network', type: 'enum', options: [network] },
          { name: 'phone', type: 'string', format: 'ng-phone' },
          { name: 'amount', type: 'number', min: 50, max: MAX_PURCHASE_AMOUNT },
        ],
      })),
    });
    // Data
    data.push({
      category: 'data',
      products: Object.entries(DATA_PLANS).map(([network, plans]) => ({
        provider: network,
        availability: 'available',
        fields: [{ name: 'planCode', type: 'enum', options: plans.map((p) => p.code) }],
        variations: plans.map((p) => ({
          code: p.code,
          customerPrice: p.price,
          name: p.name,
          mappedAtProvider: Boolean((PRODUCT_MAP.data || {})[p.code]),
        })),
      })),
    });
    // Electricity
    data.push({
      category: 'electricity',
      products: ['IKEDC', 'EKEDC', 'AEDC', 'PHED', 'KEDCO', 'IBEDC'].map((disco) => ({
        provider: disco,
        price: null,
        availability: 'available',
        fields: [
          { name: 'disco', type: 'enum', options: [disco] },
          { name: 'meterNumber', type: 'string' },
          { name: 'meterType', type: 'enum', options: ['prepaid', 'postpaid'] },
          { name: 'amount', type: 'number', min: 500, max: MAX_PURCHASE_AMOUNT },
        ],
      })),
    });
    // Cable
    data.push({
      category: 'cable',
      products: Object.entries(CABLE_PLANS).map(([provider, plans]) => ({
        provider,
        availability: 'available',
        fields: [
          { name: 'provider', type: 'enum', options: [provider] },
          { name: 'smartCardNumber', type: 'string' },
        ],
        variations: plans.map((p) => ({
          code: p.code,
          customerPrice: p.price,
          name: p.name,
          mappedAtProvider: Boolean((PRODUCT_MAP.cable || {})[p.code]),
        })),
      })),
    });
    // Education
    data.push({
      category: 'exam-pin',
      products: ENABLED_EXAM_BODIES.map((body) => ({
        provider: body,
        price: typeof EXAM_PRICES[body] === 'object' ? null : EXAM_PRICES[body] ?? null,
        availability: 'available',
        fields: [{ name: 'examBody', type: 'enum', options: [body] }, { name: 'quantity', type: 'number', max: 10 }],
      })),
    });

    res.json({
      ok: true,
      business_id: auth.businessId,
      currency: 'NGN',
      note: 'Customer-facing prices in NGN. Orders are priced server-side at confirmation time.',
      categories: data,
    });
  } catch (err) {
    logger.error('Catalogue API failed', { detail: err.message });
    sendError(res, 500, 'Could not build catalogue');
  }
});

// ── Order intents ────────────────────────────────────────────────────────────
function priceIntent(serviceType, d) {
  switch (serviceType) {
    case 'airtime': {
      const amount = parseValidatedAmount(d.amount);
      if (amount === null) return { error: 'amount must be between ₦50 and ₦1,000,000' };
      if (!d.network || !d.phone) return { error: 'network and phone are required' };
      return { amount, description: `Airtime — ${String(d.network).toUpperCase()} ${d.phone}`, payload: { serviceType, details: d } };
    }
    case 'data': {
      const network = String(d.network || '').toUpperCase();
      const plans = DATA_PLANS[network] || [];
      const plan = plans.find((p) => p.code === d.planCode);
      if (!plan) return { error: `Unknown plan ${d.planCode} for ${network}` };
      if (!(PRODUCT_MAP.data || {})[plan.code]) return { error: 'This plan is not currently purchasable' };
      return { amount: plan.price, description: `Data — ${network} ${d.phone || ''} (${plan.code})`.trim(), payload: { serviceType, details: d } };
    }
    case 'electricity': {
      const amount = parseValidatedAmount(d.amount);
      if (amount === null) return { error: 'Invalid electricity amount (min ₦500)' };
      if (amount < 500) return { error: 'Minimum electricity payment is ₦500' };
      if (!d.disco || !d.meterNumber) return { error: 'disco and meterNumber are required' };
      return { amount, description: `Electricity — ${String(d.disco).toUpperCase()} ${d.meterNumber}`, payload: { serviceType, details: d } };
    }
    case 'cable': {
      const provider = String(d.provider || '').toUpperCase();
      const plan = (CABLE_PLANS[provider] || []).find((p) => p.code === d.planCode);
      if (!plan) return { error: `Unknown bouquet ${d.planCode} for ${provider}` };
      if (!(PRODUCT_MAP.cable || {})[plan.code]) return { error: 'This bouquet is not currently purchasable' };
      if (!d.smartCardNumber) return { error: 'smartCardNumber is required' };
      return { amount: plan.price, description: `Cable — ${provider} ${d.smartCardNumber} (${plan.code})`, payload: { serviceType, details: d } };
    }
    case 'exam-pin': {
      const body = String(d.examBody || '').toUpperCase();
      if (!ENABLED_EXAM_BODIES.includes(body)) return { error: `${body} is not currently available` };
      const qty = Math.min(10, Math.max(1, parseInt(d.quantity || 1, 10) || 1));
      const unit = EXAM_PRICES[body];
      if (typeof unit !== 'number') return { error: `${body} pricing unavailable` };
      return { amount: unit * qty, description: `Exam PIN — ${body} ×${qty}`, payload: { serviceType, details: { ...d, quantity: qty } } };
    }
    default:
      return { error: 'Unsupported serviceType (airtime | data | electricity | cable | exam-pin)' };
  }
}

router.post('/order-intents', async (req, res) => {
  const auth = await authenticateBizflow(req, res);
  if (!auth) return;
  let body;
  try { body = JSON.parse(req.rawBody || '{}'); } catch { return sendError(res, 400, 'Invalid JSON'); }

  const idempotencyKey = String(body.idempotency_key || '').trim();
  if (!idempotencyKey || idempotencyKey.length > 120) return sendError(res, 400, 'idempotency_key is required');

  const existing = await db.getBizflowIntentByIdempotency(auth.businessId, idempotencyKey);
  if (existing) {
    return res.json({ ok: true, duplicate: true, intent: publicIntent(existing) });
  }

  const priced = priceIntent(String(body.serviceType || ''), body.details || {});
  if (priced.error) return sendError(res, 400, priced.error);

  const intent = await db.createBizflowOrderIntent({
    userId: auth.userId,
    bizflowBusiness: auth.businessId,
    serviceType: String(body.serviceType),
    requestPayload: priced.payload,
    amount: priced.amount,
    description: priced.description,
    idempotencyKey,
  });

  require('../services/events').emit('topflow.bizflow.order_intent.created', {
    intent_id: intent.id,
    user_id: auth.userId,
    business: auth.businessId,
    service_type: intent.service_type,
    amount: Number(intent.amount),
  }, { entityType: 'order_intent', entityId: intent.id }).catch(() => {});
  db.createNotification({
    userId: auth.userId,
    category: 'transaction',
    title: 'New business order to approve',
    message: `${auth.businessId} requested ${intent.description} — ${Number(intent.amount).toLocaleString('en-NG', { style: 'currency', currency: 'NGN' })}. Approve it in Account → Business orders.`,
    link: '/?tab=account',
  }).catch(() => {});

  res.status(201).json({ ok: true, intent: publicIntent(intent) });
});

router.get('/order-intents/:id', async (req, res) => {
  const auth = await authenticateBizflow(req, res);
  if (!auth) return;
  const intent = await db.getBizflowIntent(req.params.id);
  if (!intent || intent.bizflow_business !== auth.businessId) return sendError(res, 404, 'Intent not found');
  res.json({ ok: true, intent: publicIntent(intent) });
});

function publicIntent(i) {
  return {
    id: i.id,
    service_type: i.service_type,
    description: i.description,
    amount: Number(i.amount),
    status: i.status,
    order_request_id: i.order_request_id || null,
    created_at: i.created_at,
  };
}

module.exports = router;
