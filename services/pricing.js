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
    { code: 'MTN1GB',    name: '1GB + 1GB YouTube Night — 7 days', price: 800 },
    { code: 'MTN2GB',    name: '2GB + 2 mins — 30 days', price: 1500 },
    { code: 'MTN7GB',    name: '7GB — 2 days', price: 1800 },
    { code: 'MTN14GB',   name: '14.5GB — 30 days', price: 5000 },
    { code: 'MTN20GB',   name: '20GB — 30 days', price: 7500 },
  ],
  GLO: [
    { code: 'GLO1GB',    name: '1GB — 30 days', price: 495 },
    { code: 'GLO2GB',    name: '2GB — 30 days', price: 990 },
    { code: 'GLO5GB',    name: '5GB — 30 days', price: 2475 },
    { code: 'GLO10GB',   name: '10GB — 30 days', price: 4950 },
  ],
  AIRTEL: [
    { code: 'AIRTEL1GB',  name: '1GB — 7 days', price: 800 },
    { code: 'AIRTEL2GB',  name: '2GB — 30 days', price: 1500 },
    { code: 'AIRTEL3GB',  name: '3GB — 30 days', price: 2000 },
    { code: 'AIRTEL10GB', name: '10GB — 30 days', price: 4000 },
  ],
  '9MOBILE': [
    { code: '9MOBILE2GB',  name: '2GB — 30 days', price: 1000 },
    { code: '9MOBILE4GB',  name: '4.5GB — 30 days', price: 2000 },
    { code: '9MOBILE6GB',  name: '6.2GB — 30 days', price: 3000 },
    { code: '9MOBILE11GB', name: '11.4GB — 30 days', price: 5000 },
  ],
};

const CABLE_PLANS = {
  DSTV: [
    { code: 'DSTV_PADI',        name: 'Padi',         price: 4400 },
    { code: 'DSTV_YANGA',       name: 'Yanga',        price: 6000 },
    { code: 'DSTV_CONFAM',      name: 'Confam',       price: 11000 },
    { code: 'DSTV_COMPACT',     name: 'Compact',      price: 19000 },
    { code: 'DSTV_COMPACTPLUS', name: 'Compact Plus', price: 30000 },
    { code: 'DSTV_PREMIUM',     name: 'Premium',      price: 44500 },
    { code: 'DSTV_ASIA',        name: 'Premium Asia', price: 50500 },
  ],
  GOTV: [
    { code: 'GOTV_SMALLIE', name: 'Smallie',  price: 1900 },
    { code: 'GOTV_JINJA',   name: 'Jinja',    price: 3900 },
    { code: 'GOTV_JOLLI',   name: 'Jolli',    price: 5800 },
    { code: 'GOTV_MAX',     name: 'Max',      price: 8500 },
    { code: 'GOTV_SUPA',    name: 'Supa',     price: 11400 },
  ],
  STARTIMES: [
    { code: 'ST_NOVA',      name: 'Nova (Dish)',   price: 2100 },
    { code: 'ST_BASIC',     name: 'Basic (Antenna)', price: 4000 },
    { code: 'ST_SMART',     name: 'Basic (Dish)',  price: 5100 },
    { code: 'ST_CLASSIC',   name: 'Classic (Antenna)', price: 6000 },
    { code: 'ST_SUPER',     name: 'Super (Dish)',  price: 9800 },
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
 *   JAMB — live provider catalog returned no purchasable variations on
 *          2026-08-18, so it is disabled and unpriced.
 *   NECO / NABTEB — VTPass does not currently offer these as purchasable
 *          services, so they stay disabled and are not priced or advertised.
 */
const EXAM_PRODUCTS = {
  WAEC: {
    name: 'WAEC Result Checker',
    enabled: true,
    verified: true,
    price: 5350,
  },
  JAMB: {
    name: 'JAMB UTME PIN',
    enabled: false,
    verified: true,
    defaultVariation: 'utme-no-mock',
    reason: 'No purchasable variations returned by the live provider catalog on 2026-08-18',
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
