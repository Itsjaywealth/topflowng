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
    { code: 'DSTV_PADI',     name: 'Padi',        price: 2150 },
    { code: 'DSTV_YANGA',    name: 'Yanga',       price: 2950 },
    { code: 'DSTV_CONFAM',   name: 'Confam',      price: 5100 },
    { code: 'DSTV_COMPACT',  name: 'Compact',     price: 10500 },
    { code: 'DSTV_COMPACTPLUS', name: 'Compact Plus', price: 16600 },
    { code: 'DSTV_PREMIUM',  name: 'Premium',     price: 24200 },
    { code: 'DSTV_COMFORT',  name: 'Comfort Plus', price: 15400 },
    { code: 'DSTV_CONFAM',   name: 'Confam',       price: 8100 },
    { code: 'DSTV_YANDA',    name: 'Yanga',        price: 5900 },
    { code: 'DSTV_ASIA',     name: 'Asian Add-on', price: 3900 },
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
const EXAM_PRICES = { WAEC: 3900, NECO: 1000, NABTEB: 1000, JAMB: 4700 };

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
  };
}

module.exports = {
  DATA_PLANS, CABLE_PLANS, ELECTRICITY_DISCOS, NETWORKS, EXAM_PRICES,
  findDataPlan, findCablePlan, validatePlanAmount, validateCablePlanAmount,
  getCatalog,
};
