/**
 * TopFlowNG — Server-side pricing catalog.
 *
 * Source of truth for all service prices. The client never decides the
 * amount — it sends plan codes, and the server looks up the price.
 * Prevents amount tampering and keeps pricing consistent across the
 * platform (SPA, admin, future API consumers).
 *
 * When Clubkonnect or Paystack prices change, update ONLY this file;
 * the frontend fetches the catalog and renders the current prices.
 */

'use strict';

const DATA_PLANS = {
  MTN: [
    { code: 'MTN1GB',    name: '1GB — 30 days',     price: 350 },
    { code: 'MTN2GB',    name: '2GB — 30 days',     price: 600 },
    { code: 'MTN5GB',    name: '5GB — 30 days',     price: 1500 },
    { code: 'MTN10GB',   name: '10GB — 30 days',    price: 2500 },
    { code: 'MTN20GB',   name: '20GB — 30 days',    price: 4000 },
  ],
  GLO: [
    { code: 'GLO1GB',    name: '1GB — 30 days',     price: 400 },
    { code: 'GLO2GB',    name: '2GB — 30 days',     price: 650 },
    { code: 'GLO5GB',    name: '5GB — 30 days',     price: 1500 },
    { code: 'GLO10GB',   name: '10GB — 30 days',    price: 2500 },
  ],
  AIRTEL: [
    { code: 'AIRTEL1GB',  name: '1GB — 30 days',    price: 350 },
    { code: 'AIRTEL2GB',  name: '2GB — 30 days',    price: 600 },
    { code: 'AIRTEL5GB',  name: '5GB — 30 days',    price: 1500 },
    { code: 'AIRTEL10GB', name: '10GB — 30 days',   price: 2500 },
  ],
  '9MOBILE': [
    { code: '9MOBILE1GB',  name: '1GB — 30 days',   price: 400 },
    { code: '9MOBILE2GB',  name: '2GB — 30 days',   price: 700 },
    { code: '9MOBILE5GB',  name: '5GB — 30 days',   price: 1500 },
    { code: '9MOBILE10GB', name: '10GB — 30 days',  price: 2500 },
  ],
};

const CABLE_PLANS = {
  DSTV: [
    { code: 'DSTV_PADI',        name: 'Padi',         price: 2150 },
    { code: 'DSTV_YANGA',       name: 'Yanga',        price: 2950 },
    { code: 'DSTV_CONFAM',      name: 'Confam',       price: 5100 },
    { code: 'DSTV_COMPACT',     name: 'Compact',      price: 10500 },
    { code: 'DSTV_COMPACTPLUS', name: 'Compact Plus', price: 16600 },
    { code: 'DSTV_PREMIUM',     name: 'Premium',      price: 24200 },
    { code: 'DSTV_ASIA',        name: 'Asian Add-on', price: 3900 },
  ],
  GOTV: [
    { code: 'GOTV_SMALLIE', name: 'Smallie',  price: 900 },
    { code: 'GOTV_JINJA',   name: 'Jinja',    price: 1900 },
    { code: 'GOTV_JOLLI',   name: 'Jolli',    price: 2800 },
    { code: 'GOTV_MAX',     name: 'Max',      price: 4850 },
    { code: 'GOTV_SUPA',    name: 'Supa',     price: 6400 },
  ],
  STARTIMES: [
    { code: 'ST_NOVA',      name: 'Nova — Basic',  price: 900 },
    { code: 'ST_BASIC',     name: 'Basic',         price: 1850 },
    { code: 'ST_SMART',     name: 'Smart',         price: 2600 },
    { code: 'ST_CLASSIC',   name: 'Classic',       price: 3100 },
    { code: 'ST_SUPER',     name: 'Super',         price: 6200 },
  ],
};

const ELECTRICITY_DISCOS = [
  { code: 'IKEDC',  name: 'Ikeja Electric' },
  { code: 'EKEDC',  name: 'Eko Electric' },
  { code: 'AEDC',   name: 'Abuja Electric' },
  { code: 'PHEDC',  name: 'Port Harcourt Electric' },
  { code: 'KEDC',   name: 'Kano Electric' },
  { code: 'IBEDC',  name: 'Ibadan Electric' },
];

const NETWORKS = ['MTN', 'GLO', 'AIRTEL', '9MOBILE'];

/**
 * Exam-PIN catalogue.
 *
 * `enabled` is the single source of truth consumed by the API, the customer UI
 * and the admin product registry. A body may only be enabled when its VTPass
 * serviceID *and* variation code have been verified against the provider
 * documentation — an enabled-but-unverified product is structurally forbidden,
 * because it would send money toward a guessed variation code.
 *
 *   WAEC — verified: serviceID "waec", variation "waecdirect".
 *   JAMB — verified 2026-08-18: serviceID "jamb",
 *          variations utme-mock (₦7,700) / utme-no-mock (₦6,200).
 *   NECO / NABTEB — VTPass does not currently offer these as purchasable
 *          services, so they stay disabled and are not priced or advertised.
 */
const EXAM_PRODUCTS = {
  WAEC: {
    name: 'WAEC Result Checker',
    enabled: true,
    verified: true,
    price: 3900,
  },
  JAMB: {
    name: 'JAMB UTME PIN',
    enabled: true,
    verified: true,
    defaultVariation: 'utme-no-mock',
    variations: [
      { code: 'utme-no-mock', name: 'UTME PIN (without mock)', price: 6200 },
      { code: 'utme-mock', name: 'UTME PIN (with mock)', price: 7700 },
    ],
  },
  NECO: {
    name: 'NECO Result Checker',
    enabled: false,
    verified: true, // verified as UNAVAILABLE on the active provider
    reason: 'Not offered by the active provider',
  },
  NABTEB: {
    name: 'NABTEB Result Checker',
    enabled: false,
    verified: true, // verified as UNAVAILABLE on the active provider
    reason: 'Not offered by the active provider',
  },
};

/**
 * Flat price lookup for the enabled exam bodies only. Object values mean the
 * body is variation-priced. Disabled bodies deliberately have NO price entry,
 * so nothing downstream can quote or charge for them.
 */
const EXAM_PRICES = Object.fromEntries(
  Object.entries(EXAM_PRODUCTS)
    .filter(([, p]) => p.enabled)
    .map(([body, p]) => [
      body,
      p.variations
        ? Object.fromEntries(p.variations.map((v) => [v.code, v.price]))
        : p.price,
    ])
);

/** Exam bodies customers may actually purchase. */
const ENABLED_EXAM_BODIES = Object.keys(EXAM_PRICES);

/**
 * Resolve the unit price for an exam body (+ optional variation).
 * Returns null for disabled bodies and unknown variations, so callers fail
 * closed rather than charging a guessed amount.
 */
function findExamPrice(examBody, variation) {
  const entry = EXAM_PRICES[String(examBody || '').toUpperCase()];
  if (entry === undefined) return null;
  if (typeof entry === 'number') return entry;
  const product = EXAM_PRODUCTS[String(examBody).toUpperCase()];
  const key = variation && entry[variation] !== undefined ? variation : product.defaultVariation;
  const price = entry[key];
  return typeof price === 'number' ? price : null;
}

/**
 * Look up a data plan by network and plan code. Returns the plan object
 * with { code, name, price } or null if not found.
 */
function findDataPlan(network, planCode) {
  const plans = DATA_PLANS[network?.toUpperCase()];
  if (!plans) return null;
  return plans.find(p => p.code === planCode) || null;
}

/**
 * Look up a cable plan by provider and plan code.
 */
function findCablePlan(provider, planCode) {
  const plans = CABLE_PLANS[provider?.toUpperCase()];
  if (!plans) return null;
  return plans.find(p => p.code === planCode) || null;
}

/**
 * Validate that the requested amount matches the catalog price for
 * a given plan. Throws if mismatched, making amount tampering visible.
 */
function validatePlanAmount(network, planCode, clientAmount) {
  const plan = findDataPlan(network, planCode);
  if (!plan) throw new Error(`Unknown plan: ${planCode} for ${network}`);
  if (Math.abs(plan.price - Number(clientAmount)) > 0.01) {
    throw new Error(`Price mismatch for ${planCode}: expected ₦${plan.price}, got ₦${clientAmount}`);
  }
  return plan;
}

function validateCablePlanAmount(provider, planCode, clientAmount) {
  const plan = findCablePlan(provider, planCode);
  if (!plan) throw new Error(`Unknown plan: ${planCode} for ${provider}`);
  if (Math.abs(plan.price - Number(clientAmount)) > 0.01) {
    throw new Error(`Price mismatch for ${planCode}: expected ₦${plan.price}, got ₦${clientAmount}`);
  }
  return plan;
}

/**
 * Return the full catalog for the /api/vtu/plans endpoint.
 */
function getCatalog() {
  return {
    data: DATA_PLANS,
    cable: CABLE_PLANS,
    electricity: ELECTRICITY_DISCOS,
    networks: NETWORKS,
    examPrices: EXAM_PRICES,
    // Full exam catalogue including the deliberately disabled bodies, so the
    // UI renders availability from data instead of hardcoding it.
    examProducts: Object.entries(EXAM_PRODUCTS).map(([code, p]) => ({
      code,
      name: p.name,
      enabled: p.enabled,
      reason: p.reason || null,
      price: p.price ?? null,
      defaultVariation: p.defaultVariation || null,
      variations: p.variations || null,
    })),
  };
}

module.exports = {
  DATA_PLANS, CABLE_PLANS, ELECTRICITY_DISCOS, NETWORKS,
  EXAM_PRICES, EXAM_PRODUCTS, ENABLED_EXAM_BODIES,
  findDataPlan, findCablePlan, findExamPrice,
  validatePlanAmount, validateCablePlanAmount,
  getCatalog,
};
