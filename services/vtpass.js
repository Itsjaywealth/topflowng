/**
 * TopFlowNG — VTPass VTU provider client.
 *
 * Replaces the legacy Clubkonnect/Nellobyte client whose API went dead
 * (every endpoint returned MISSING_PHONE_NUMBER regardless of credentials).
 *
 * VTPass contract (https://vtpass.com/documentation):
 *   POST /api/pay      — purchase; auth headers: api-key + secret-key
 *   POST /api/requery  — transaction status by request_id; same headers
 *   GET  /api/service-variations?serviceID= — plan catalog; headers: api-key + public-key
 *
 * Responses are normalised into the same small outcome object the old client
 * produced (outcome: success|pending|failed) plus VTPass-specific fields
 * (token / purchasedCode from the vend result), so routes and reconciliation
 * only change where the request body is built. Responses are never logged in
 * full — only status / code / orderId.
 *
 * VTPass status semantics (per documented response codes):
 *   code "000"        — processed; actual state is content.transactions.status
 *                       (delivered = success, initiated/pending = still open)
 *   099 / 089 / 001   — still processing; requery later
 *   014               — request_id already used; a duplicate — requery by it
 *   091/016/040 and the 0xx reject codes — terminal failure, not charged
 *   anything else     — treat as pending and requery (provider guidance)
 */

'use strict';

const crypto = require('crypto');

const axios = require('axios');

const config = require('../config');
const db = require('../database');
const logger = require('../lib/logger');
const { ApiError } = require('../lib/errors');
const cache = require('../lib/cache');
const sms = require('./sms');
const push = require('./push');
const {
  DATA_PLANS, CABLE_PLANS, ELECTRICITY_DISCOS, EXAM_PRODUCTS, NETWORKS,
} = require('./pricing');

const MAX_PURCHASE_AMOUNT = config.vtpass.maxPurchaseAmount;

function parseValidatedAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount <= 0 || amount > MAX_PURCHASE_AMOUNT) return null;
  return amount;
}

/**
 * VTPass request_id: first 12 chars numeric = YYYYMMDDHHII (Africa/Lagos,
 * i.e. UTC+1 — Lagos has no DST) of today, then any alphanumeric suffix.
 */
function buildRequestId() {
  const d = new Date(Date.now() + 60 * 60 * 1000); // Lagos = UTC+1
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
  return `${base}${crypto.randomBytes(6).toString('hex')}`;
}

// ── VTPass service IDs ───────────────────────────────────────────────────────
const NETWORK_SERVICE = {
  MTN: 'mtn',
  GLO: 'glo',
  AIRTEL: 'airtel',
  '9MOBILE': 'etisalat',
  ETISALAT: 'etisalat',
};

const DATA_SERVICE = {
  MTN: 'mtn-data',
  GLO: 'glo-data',
  AIRTEL: 'airtel-data',
  '9MOBILE': 'etisalat-data',
  ETISALAT: 'etisalat-data',
};

const DISCO_SERVICE = {
  IKEDC: 'ikeja-electric',
  EKEDC: 'eko-electric',
  AEDC: 'abuja-electric',
  PHEDC: 'portharcourt-electric',
  KEDC: 'kano-electric',
  IBEDC: 'ibadan-electric',
  JED: 'jos-electric',
  KAEDCO: 'kaduna-electric',
  EEDC: 'enugu-electric',
  BEDC: 'benin-electric',
  APLE: 'aba-electric',
  YEDC: 'yola-electric',
  KEDCO: 'kano-electric',
  IKEJA: 'ikeja-electric',
};

const CABLE_SERVICE = { DSTV: 'dstv', GOTV: 'gotv', STARTIMES: 'startimes' };

/**
 * Static product → serviceID/variation map for services whose catalogue is
 * retail-plan-keyed (data bundles, cable bouquets, exam pins, recharge pins).
 *
 * The codes below are the best-known VTPass variation codes from the public
 * documentation. Operators with live keys MUST verify/adjust them against
 * `GET /api/service-variations?serviceID=<id>` (or `VTPASS_PRODUCT_MAP`),
 * because variation codes change as billers repackage bundles. Any plan that
 * is not in this map fails fast with a clear error rather than sending money
 * toward a guessed variation code.
 */
const PRODUCT_MAP = {
  // NOTE: keys are the flat TopFlowNG plan codes (DATA_PLANS/CABLE_PLANS `.code`),
  // NOT network-nested. lookupProduct(kind, planCode) reads PRODUCT_MAP[kind][key]
  // directly, so nesting by network silently unmaps every plan. All variation
  // codes below were re-verified against the live VTPass service-variations
  // catalogue on 2026-08-18.
  data: {
    MTN1GB: 'mtn-1gb-600', MTN2GB: 'mtn-xtra-1000', MTN7GB: 'mtn-7gb-1800',
    MTN14GB: 'mtn-14.5gb-5000', MTN20GB: 'mtn-20gb-7500',
    GLO1GB: 'glo-dg-495', GLO2GB: 'glo-dg-990', GLO5GB: 'glo-dg-2475', GLO10GB: 'glo-dg-4950',
    AIRTEL1GB: 'airt-800-7', AIRTEL2GB: 'airt-1500-30', AIRTEL3GB: 'airt-2000', AIRTEL10GB: 'airt-4000',
    '9MOBILE2GB': 'eti-1000', '9MOBILE4GB': 'eti-2000',
    '9MOBILE6GB': 'eti-3000', '9MOBILE11GB': 'eti-5000',
  },
  cable: {
    DSTV_PADI: 'dstv-padi',
    DSTV_YANGA: 'dstv-yanga',
    DSTV_CONFAM: 'dstv-confam',
    DSTV_COMPACT: 'dstv79',
    DSTV_COMPACTPLUS: 'dstv7',
    DSTV_PREMIUM: 'dstv3',
    DSTV_ASIA: 'dstv10',
    GOTV_SMALLIE: 'gotv-smallie',
    GOTV_JINJA: 'gotv-jinja',
    GOTV_JOLLI: 'gotv-jolli',
    GOTV_MAX: 'gotv-max',
    GOTV_SUPA: 'gotv-supa',
    ST_NOVA: 'nova',
    ST_BASIC: 'basic',
    ST_SMART: 'smart',
    ST_CLASSIC: 'classic',
    ST_SUPER: 'super',
  },
  exam: {
    WAEC: { serviceID: 'waec', variation: 'waecdirect' },
    // JAMB documentation describes the service, but the live variation
    // endpoint returned no purchasable options on 2026-08-18. It therefore
    // remains deliberately unmapped and disabled.
  },
  recharge: {
    // Recharge-card PIN (ePIN) vending exists on VTPass but the exact
    // serviceIDs are merchant-specific and are NOT verified against the
    // documentation — left intentionally empty. Configure via VTPASS_PRODUCT_MAP
    // once confirmed, e.g. {"MTN":{"serviceID":"mtn-recharge-card-pin"}}.
  },
};

let productMapOverride = null;
try {
  if (config.vtpass.productMapJson) {
    productMapOverride = JSON.parse(config.vtpass.productMapJson);
  }
} catch (err) {
  throw new Error(`[config] VTPASS_PRODUCT_MAP is not valid JSON: ${err.message}`);
}

function lookupProduct(kind, key) {
  const section = (productMapOverride && productMapOverride[kind]) || PRODUCT_MAP[kind] || {};
  return section[key] || PRODUCT_MAP[kind]?.[key] || null;
}

class VtpassProductError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VtpassProductError';
    this.code = 'VTPASS_PRODUCT_UNAVAILABLE';
  }
}

/**
 * Build the VTPass purchase body for a service type from route-validated input.
 * Throws VtpassProductError for plans the provider catalogue does not (yet)
 * cover, so money is never sent toward an unverified variation code.
 */
function productFor(serviceType, ctx) {
  const network = String(ctx.network || '').toUpperCase();
  const key = `${serviceType}:${network}:${ctx.planCode || ''}`;
  switch (serviceType) {
    case 'airtime': {
      const serviceID = NETWORK_SERVICE[network];
      if (!serviceID) throw new VtpassProductError(`Unsupported network: ${network}`);
      return { serviceID, amount: Number(ctx.amount), phone: String(ctx.phone) };
    }
    case 'data': {
      const serviceID = DATA_SERVICE[network];
      const variation = lookupProduct('data', ctx.planCode);
      if (!serviceID || !variation) {
        throw new VtpassProductError(`Data plan ${ctx.planCode} is not mapped on the active provider (${key})`);
      }
      return { serviceID, variation_code: variation, phone: String(ctx.phone) };
    }
    case 'cable': {
      const provider = String(ctx.provider || '').toUpperCase();
      const serviceID = CABLE_SERVICE[provider];
      const variation = lookupProduct('cable', ctx.planCode);
      if (!serviceID || !variation) {
        throw new VtpassProductError(`Cable package ${provider}/${ctx.planCode} is not mapped on the active provider`);
      }
      return {
        serviceID,
        variation_code: variation,
        billersCode: String(ctx.smartCardNumber),
        phone: String(ctx.phone || ''),
        subscription_type: 'renew',
        quantity: 1,
      };
    }
    case 'electricity': {
      const disco = String(ctx.disco || '').toUpperCase();
      const serviceID = DISCO_SERVICE[disco];
      const meterType = String(ctx.meterType || 'prepaid').toLowerCase();
      if (!serviceID) throw new VtpassProductError(`Unsupported electricity provider: ${disco}`);
      if (!['prepaid', 'postpaid'].includes(meterType)) {
        throw new VtpassProductError(`Unsupported meter type: ${meterType}`);
      }
      return {
        serviceID,
        variation_code: meterType,
        billersCode: String(ctx.meterNumber),
        amount: Number(ctx.amount),
        phone: String(ctx.phone || ''),
      };
    }
    case 'exam-pin': {
      const entry = lookupProduct('exam', ctx.examBody);
      if (!entry) {
        throw new VtpassProductError(
          `${ctx.examBody} exam pins are not available on the active provider. Only ${Object.keys(PRODUCT_MAP.exam).join(', ')} pins can be purchased.`
        );
      }
      // Multi-variation exams (e.g. JAMB: utme-mock vs utme-no-mock)
      const varCode = entry.variations
        ? (ctx.examVariation && Object.prototype.hasOwnProperty.call(entry.variations, ctx.examVariation)
            ? ctx.examVariation
            : entry.variation)
        : entry.variation;
      return {
        serviceID: entry.serviceID,
        variation_code: varCode,
        quantity: Number(ctx.quantity || 1),
      };
    }
    case 'recharge-pin': {
      const entry = lookupProduct('recharge', network);
      if (!entry) {
        throw new VtpassProductError(
          `Recharge card PIN vending is not yet configured on the active provider. Configure it via VTPASS_PRODUCT_MAP.`
        );
      }
      return {
        serviceID: entry.serviceID,
        amount: Number(ctx.amount),
        quantity: Number(ctx.quantity || 1),
        phone: String(ctx.phone || ''),
      };
    }
    default:
      throw new VtpassProductError(`Unsupported service type: ${serviceType}`);
  }
}

/**
 * Canonical customer/admin product inventory. This is derived from the same
 * provider mappings used to build purchase requests, so an enabled-but-
 * unmapped item cannot appear as healthy in diagnostics.
 */
function getProductRegistry() {
  const verifiedAt = '2026-08-18';
  const rows = [];
  const push = (row) => rows.push({
    provider: 'VTPass',
    priceSource: row.priceSource || 'services/pricing.js',
    lastVerified: row.lastVerified || verifiedAt,
    providerAvailability: row.enabled ? 'AVAILABLE' : 'UNAVAILABLE',
    state: row.enabled ? 'VALID' : (row.state || 'DISABLED'),
    ...row,
  });

  for (const network of NETWORKS) {
    push({
      category: 'Airtime', displayName: `${network} Airtime`, internalId: `airtime:${network}`,
      serviceId: NETWORK_SERVICE[network] || null, variation: null,
      enabled: Boolean(NETWORK_SERVICE[network]), customerUiState: 'enabled', priceSource: 'customer amount within server limits',
    });
  }
  for (const [network, plans] of Object.entries(DATA_PLANS)) {
    for (const plan of plans) {
      const variation = lookupProduct('data', plan.code);
      push({
        category: 'Data', displayName: `${network} ${plan.name}`, internalId: plan.code,
        serviceId: DATA_SERVICE[network] || null, variation: variation || null,
        enabled: Boolean(DATA_SERVICE[network] && variation), customerUiState: variation ? 'enabled' : 'disabled',
        price: plan.price, state: variation ? 'VALID' : 'UNMAPPED',
      });
    }
  }
  for (const disco of ELECTRICITY_DISCOS) {
    push({
      category: 'Electricity', displayName: disco.name, internalId: disco.code,
      serviceId: DISCO_SERVICE[disco.code] || null, variation: 'prepaid/postpaid',
      enabled: Boolean(DISCO_SERVICE[disco.code]), customerUiState: 'enabled', priceSource: 'customer amount within server limits',
    });
  }
  for (const [provider, plans] of Object.entries(CABLE_PLANS)) {
    for (const plan of plans) {
      const variation = lookupProduct('cable', plan.code);
      push({
        category: 'Cable', displayName: `${provider} ${plan.name}`, internalId: plan.code,
        serviceId: CABLE_SERVICE[provider] || null, variation: variation || null,
        enabled: Boolean(CABLE_SERVICE[provider] && variation), customerUiState: variation ? 'enabled' : 'disabled',
        price: plan.price, state: variation ? 'VALID' : 'UNMAPPED',
      });
    }
  }
  for (const [code, exam] of Object.entries(EXAM_PRODUCTS)) {
    const mapping = lookupProduct('exam', code);
    const variations = exam.variations || [{ code: mapping?.variation || null, name: exam.name, price: exam.price }];
    for (const variation of variations) {
      const enabled = Boolean(exam.enabled && exam.verified && mapping && variation.code);
      push({
        category: 'Exam', displayName: variation.name || exam.name,
        internalId: variation.code ? `${code}:${variation.code}` : code,
        serviceId: mapping?.serviceID || null, variation: variation.code || null,
        enabled, customerUiState: enabled ? 'enabled' : 'disabled', price: variation.price ?? null,
        state: enabled ? 'VALID' : (exam.verified ? 'PROVIDER_UNAVAILABLE' : 'UNMAPPED'),
        providerAvailability: enabled ? 'AVAILABLE' : 'UNAVAILABLE',
      });
    }
  }
  for (const network of NETWORKS) {
    const mapping = lookupProduct('recharge', network);
    push({
      category: 'Recharge PIN', displayName: `${network} Recharge Card PIN`, internalId: `recharge:${network}`,
      serviceId: mapping?.serviceID || null, variation: mapping?.variation || null,
      enabled: false, customerUiState: 'disabled', state: mapping ? 'DISABLED' : 'UNMAPPED',
      providerAvailability: mapping ? 'UNVERIFIED' : 'UNAVAILABLE', priceSource: 'not configured',
    });
  }
  return rows;
}

// ── Response normalisation ───────────────────────────────────────────────────
// Response codes that mean "open, query again" (from the VTPass docs).
const VT_PENDING_CODES = new Set(['001', '014', '089', '099']);

// Terminal rejections — the transaction is not processed and the wallet is not
// (or has already been refunded with 040). Includes the auth failures (087) so
// a misconfigured key is surfaced as an honest failure, not a silent pending.
const VT_FAILURE_CODES = new Set([
  '010', '011', '012', '013', '015', '016', '017', '018', '019',
  '021', '022', '023', '024', '025', '026', '027', '028', '030',
  '031', '032', '034', '035', '040', '083', '085', '086', '087', '091',
]);

function parseRaw(raw) {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (!text) return {};
    try { return JSON.parse(text); } catch { /* fallthrough to pipe format */ }
    // VTPass "text" output format: 000|TRANSACTION SUCCESSFUL|[content...]
    const parts = text.split('|');
    if (parts.length >= 1) {
      return { code: parts[0].trim(), response_description: parts[1]?.trim() || '' };
    }
  }
  return {};
}

function normalizeVtpassResponse(raw) {
  const data = parseRaw(raw);
  const code = data.code !== undefined && data.code !== null ? String(data.code).trim() : null;
  const txn = data.content && data.content.transactions ? data.content.transactions : null;
  const txnStatus = txn && txn.status ? String(txn.status).trim().toLowerCase() : '';
  const description = String(data.response_description || '').trim();
  const remark = String(data.message || '').trim() || description;
  const orderIdCandidate = txn && txn.transactionId
    ? String(txn.transactionId).trim()
    : '';
  const orderId = orderIdCandidate && orderIdCandidate !== '0' ? orderIdCandidate : null;
  // Vend results (exam PINs, electricity tokens) land in purchased_code or token.
  const purchasedCode = String(data.purchased_code || (txn && txn.purchased_code) || '').trim();
  const token = String(data.token || (txn && txn.token) || data.extras || '').trim() || purchasedCode;
  const statusCode = code && /^\d+$/.test(code) ? Number(code) : null;

  const base = { statusCode, status: txnStatus || code || '', remark, description, orderId, token, purchasedCode, raw: data };

  if (code === '000') {
    if (txnStatus === 'delivered') return { outcome: 'success', ...base };
    // initiated / pending / missing inner status — still open.
    return { outcome: 'pending', ...base };
  }
  if (code && VT_FAILURE_CODES.has(code)) return { outcome: 'failed', ...base };
  if (code && VT_PENDING_CODES.has(code)) return { outcome: 'pending', ...base };
  // Undocumented / missing code — provider guidance says treat as pending and
  // requery, which the sweeper will do by request_id.
  return { outcome: 'pending', ...base };
}

/**
 * Returns { headers, auth? } to spread into axios request config.
 * When VTPASS_AUTH_TYPE=basic, uses HTTP Basic auth (email + password).
 * Falls back to API-key headers otherwise.
 */
function authConfig(kind) {
  if (config.vtpass.authType === 'basic') {
    return {
      headers: {},
      auth: {
        username: config.vtpass.username,
        password: config.vtpass.password,
      },
    };
  }
  const headers = { 'api-key': config.vtpass.apiKey };
  if (kind === 'get') headers['public-key'] = config.vtpass.publicKey;
  else headers['secret-key'] = config.vtpass.secretKey;
  return { headers };
}

// Keep backward-compatible alias used in tests / external callers
function authHeaders(kind) {
  return authConfig(kind).headers;
}

function assertConfigured() {
  const isBasic = config.vtpass.authType === 'basic';
  if (isBasic) {
    if (!config.vtpass.username || !config.vtpass.password) {
      const error = new ApiError(503, 'VTPass Basic auth is not configured (VTPASS_USERNAME / VTPASS_PASSWORD missing)');
      error.code = 'VTPASS_NOT_CONFIGURED';
      throw error;
    }
  } else if (!config.vtpass.apiKey || !config.vtpass.secretKey) {
    const error = new ApiError(503, 'VTPass purchase API is not configured');
    error.code = 'VTPASS_NOT_CONFIGURED';
    throw error;
  }
}

// ── Variation catalog (used to resolve fixed-price exam pins, and available
// to operators/tests to validate PRODUCT_MAP) ────────────────────────────────
const variationCache = new Map();
const VARIATION_CACHE_TTL_MS = 10 * 60 * 1000;

async function fetchVariations(serviceID) {
  const cacheKey = `vtpass:variations:${serviceID}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;

  if (!config.vtpass.apiKey || !config.vtpass.publicKey) {
    const error = new ApiError(503, 'VTPass variation catalog is not configured');
    error.code = 'VTPASS_PUBLIC_KEY_MISSING';
    throw error;
  }
  const response = await axios.get(`${config.vtpass.baseUrl}/service-variations`, {
    params: { serviceID },
    ...authConfig('get'),
    timeout: config.vtpass.timeoutMs,
  });
  const content = response.data && response.data.content;
  const variations = (content && content.variations) || (content && content.varations) || [];
  await cache.set(cacheKey, variations, 10 * 60 * 1000);
  return variations;
}

async function variationAmount(serviceID, variationCode) {
  const variations = await fetchVariations(serviceID);
  const match = variations.find((v) => String(v.variation_code) === variationCode);
  if (!match) throw new VtpassProductError(`Unknown ${serviceID} variation: ${variationCode}`);
  const amount = Number(match.variation_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new VtpassProductError(`No fixed price known for ${serviceID}/${variationCode}`);
  }
  return amount;
}

// ── Purchase / query ─────────────────────────────────────────────────────────
async function queryVtpassOrder(requestId) {
  assertConfigured();
  try {
    const response = await axios.post(`${config.vtpass.baseUrl}/requery`, { request_id: requestId }, {
      ...authConfig('post'),
      timeout: config.vtpass.timeoutMs,
    });
    return normalizeVtpassResponse(response.data);
  } catch (err) {
    if (err.response?.data) return normalizeVtpassResponse(err.response.data);
    const error = new Error(`VTPass Query API request failed: ${err.message}`);
    error.code = 'VTPASS_QUERY_UNREACHABLE';
    throw error;
  }
}

function serviceLabel(serviceType) {
  const labels = { airtime: 'Airtime', data: 'Data', electricity: 'Electricity', cable: 'Cable TV', 'exam-pin': 'Exam PIN', 'recharge-pin': 'Recharge PIN' };
  return labels[serviceType] || 'Purchase';
}

async function notifyPurchase({ userId, requestId, serviceType, amount, description, outcome }) {
  const service = serviceLabel(serviceType);
  const amountText = `₦${Number(amount).toLocaleString()}`;
  let title, message, category, link;
  if (outcome === 'success') {
    title = `${service} purchase successful`;
    message = `Your ${amountText} ${service.toLowerCase()} purchase was successful.`;
    category = 'transaction';
    link = `/api/wallet/transactions?q=${encodeURIComponent(requestId)}`;
  } else if (outcome === 'pending') {
    title = `${service} purchase pending`;
    message = `Your ${amountText} ${service.toLowerCase()} purchase is awaiting provider confirmation. Your wallet has not been debited.`;
    category = 'transaction';
    link = `/api/wallet/transactions?q=${encodeURIComponent(requestId)}`;
  } else if (outcome === 'failed') {
    title = `${service} purchase failed`;
    message = `Your ${amountText} ${service.toLowerCase()} purchase could not be completed. You have not been charged.`;
    category = 'transaction';
    link = `/api/wallet/transactions?q=${encodeURIComponent(requestId)}`;
  } else {
    return;
  }
  await db.createNotification({ userId, category, title, message, link }).catch(() => {});
  // SMS notification
  db.findUserById(userId).then(user => {
    if (user && user.phone) {
      sms.sendSms(user.phone, sms.purchaseMessage(serviceType, amount, outcome)).catch(() => {});
    }
  }).catch(() => {});
  // Push notification
  push.sendPush(userId, title, message, link).catch(() => {});
}

async function processVtpassPurchase({ userId, requestId, serviceType, amount, description, product }) {
  await db.createVtuAttempt({ requestId, userId, serviceType, amount, description });

  let providerRaw;
  try {
    const body = {
      request_id: requestId,
      serviceID: product.serviceID,
    };
    if (product.variation_code !== undefined) body.variation_code = product.variation_code;
    if (product.billersCode !== undefined) body.billersCode = product.billersCode;
    if (product.amount !== undefined) body.amount = product.amount;
    if (product.phone !== undefined) body.phone = product.phone;
    if (product.subscription_type !== undefined) body.subscription_type = product.subscription_type;
    if (product.quantity !== undefined) body.quantity = product.quantity;

    const response = await axios.post(`${config.vtpass.baseUrl}/pay`, body, {
      ...authConfig('post'),
      timeout: config.vtpass.timeoutMs,
    });
    providerRaw = response.data;
  } catch (err) {
    providerRaw = err.response?.data;
    if (!providerRaw) {
      // The provider may still have accepted the request despite our timeout.
      // Hold the order and leave the wallet unchanged until it is reconciled.
      await db.recordVtuProviderResponse(requestId, {
        statusCode: null,
        status: 'UNKNOWN',
        remark: 'Provider connection unresolved',
        description: err.message,
        orderId: null,
        token: '',
        purchasedCode: '',
        raw: { error: err.message },
      });
      await db.markVtuOrderPending(requestId);
      logger.warn(`VTPass purchase pending reconciliation: ${requestId}`, { reason: err.message });
      return { outcome: 'pending', message: 'Your request is pending provider confirmation. Your wallet has not been debited.', requestId, orderId: null };
    }
  }

  const provider = normalizeVtpassResponse(providerRaw);
  await db.recordVtuProviderResponse(requestId, provider);

  if (provider.outcome === 'success') {
    try {
      const result = await db.completeVtuOrder(requestId);
      logger.info('VTPass purchase completed', { requestId, orderId: provider.orderId || 'no provider order id' });
      await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'success' });
      return { outcome: 'success', balance: result.balance, requestId, orderId: provider.orderId, provider };
    } catch (err) {
      // Provider confirmed delivery, but the local settlement could not be
      // recorded (e.g. wallet is empty, or the DB write failed). Park it in
      // the reconcilable 'pending' state with its provider reference intact.
      logger.error('VTPass confirmed delivery but local settlement failed; holding for reconciliation', {
        requestId,
        orderId: provider.orderId || 'no provider order id',
        message: err.message,
      });
      await db.markVtuOrderPending(requestId).catch(() => {});
      await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'pending' });
      return {
        outcome: 'pending',
        message: 'Delivery was confirmed but the wallet debit could not be recorded. The order is held for reconciliation; your wallet has not been debited.',
        requestId,
        orderId: provider.orderId,
        provider,
      };
    }
  }

  if (provider.outcome === 'failed') {
    await db.markVtuOrderFailed(requestId);
    logger.warn('VTPass purchase failed without wallet debit', { requestId, statusCode: provider.statusCode || 'unknown', code: provider.status });
    await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'failed' });
    return { outcome: 'failed', message: provider.description || provider.remark || 'The provider declined this purchase.', requestId, orderId: provider.orderId, provider };
  }

  await db.markVtuOrderPending(requestId);
  logger.warn('VTPass purchase pending reconciliation', { requestId, statusCode: provider.statusCode || 'unknown', remark: provider.remark || '' });
  await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'pending' });
  return {
    outcome: 'pending',
    message: 'Your request is pending provider confirmation. Your wallet has not been debited.',
    requestId,
    orderId: provider.orderId,
    provider,
  };
}

// ── Direct-pay purchase (PAYMENT_MODE=direct) ────────────────────────────────
// Same provider request/response handling as processVtpassPurchase, but the
// customer already paid the payment provider for THIS order. On confirmed
// delivery the order is completed WITHOUT debiting the stored customer wallet
// (completeDirectOrder). Payment must already be verified before calling this.
async function processDirectPurchase({ userId, requestId, serviceType, amount, description, product, paymentReference = null }) {
  await db.createVtuAttempt({ requestId, userId, serviceType, amount, description });

  let providerRaw;
  try {
    const body = {
      request_id: requestId,
      serviceID: product.serviceID,
    };
    if (product.variation_code !== undefined) body.variation_code = product.variation_code;
    if (product.billersCode !== undefined) body.billersCode = product.billersCode;
    if (product.amount !== undefined) body.amount = product.amount;
    if (product.phone !== undefined) body.phone = product.phone;
    if (product.subscription_type !== undefined) body.subscription_type = product.subscription_type;
    if (product.quantity !== undefined) body.quantity = product.quantity;

    const response = await axios.post(`${config.vtpass.baseUrl}/pay`, body, {
      ...authConfig('post'),
      timeout: config.vtpass.timeoutMs,
    });
    providerRaw = response.data;
  } catch (err) {
    providerRaw = err.response?.data;
    if (!providerRaw) {
      // Provider may still have accepted the request despite our timeout.
      await db.recordVtuProviderResponse(requestId, {
        statusCode: null, status: 'UNKNOWN',
        remark: 'Provider connection unresolved', description: err.message,
        orderId: null, token: '', purchasedCode: '',
        raw: { error: err.message },
      });
      await db.markVtuOrderPending(requestId);
      logger.warn(`VTPass direct purchase pending reconciliation: ${requestId}`, { reason: err.message });
      return { outcome: 'pending', message: 'Your order is pending provider confirmation.', requestId, orderId: null };
    }
  }

  const provider = normalizeVtpassResponse(providerRaw);
  await db.recordVtuProviderResponse(requestId, provider);

  if (provider.outcome === 'success') {
    try {
      const result = await db.completeDirectOrder(requestId, { paymentReference });
      logger.info('VTPass direct purchase completed', { requestId, orderId: provider.orderId || 'no provider order id' });
      await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'success' });
      return { outcome: 'success', requestId, orderId: provider.orderId, provider };
    } catch (err) {
      logger.error('VTPass confirmed delivery but direct completion failed; holding for reconciliation', { requestId, message: err.message });
      await db.markVtuOrderPending(requestId).catch(() => {});
      await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'pending' });
      return { outcome: 'pending', message: 'Delivery confirmed but completion is pending reconciliation.', requestId, orderId: provider.orderId, provider };
    }
  }

  if (provider.outcome === 'failed') {
    await db.markVtuOrderFailed(requestId);
    logger.warn('VTPass direct purchase failed', { requestId, statusCode: provider.statusCode || 'unknown', code: provider.status });
    await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'failed' });
    return { outcome: 'failed', message: provider.description || provider.remark || 'The provider declined this purchase.', requestId, orderId: provider.orderId, provider };
  }

  await db.markVtuOrderPending(requestId);
  logger.warn('VTPass direct purchase pending reconciliation', { requestId });
  await notifyPurchase({ userId, requestId, serviceType, amount, description, outcome: 'pending' });
  return { outcome: 'pending', message: 'Your order is pending provider confirmation.', requestId, orderId: provider.orderId, provider };
}

module.exports = {
  MAX_PURCHASE_AMOUNT,
  parseValidatedAmount,
  buildRequestId,
  VtpassProductError,
  VT_PENDING_CODES,
  VT_FAILURE_CODES,
  PRODUCT_MAP,
  NETWORK_SERVICE,
  DATA_SERVICE,
  DISCO_SERVICE,
  CABLE_SERVICE,
  productFor,
  getProductRegistry,
  variationAmount,
  fetchVariations,
  normalizeVtpassResponse,
  queryVtpassOrder,
  processVtpassPurchase,
  processDirectPurchase,
  authConfig,
  assertConfigured,
};
