/**
 * TopFlowNG — VTPass provider adapter.
 *
 * Formalizes the `UtilityProvider` interface for the owned application. This
 * layer DELEGATES all working business logic to services/vtpass.js (no logic
 * duplication) and adds the read-only provider surfaces (getBalance, health)
 * that the platform needs to run independently of the reseller frontend.
 *
 * The owned application treats VTPass purely as a backend provider. It never
 * depends on the rechargewebsite.com reseller frontend.
 */

'use strict';

const config = require('../config');
const vtpass = require('../services/vtpass');

// ── Provider state ───────────────────────────────────────────────────────────
const PROVIDER_STATUS = { OPERATIONAL: 'OPERATIONAL', DEGRADED: 'DEGRADED', UNAVAILABLE: 'UNAVAILABLE' };

let healthCache = null;
const HEALTH_CACHE_TTL_MS = 60 * 1000;

/**
 * Read-only wallet balance from VTPass. Returns a number when the balance
 * endpoint responds, otherwise null (never throws, never blocks the app).
 */
async function getBalance() {
  const axios = require('axios');
  try {
    vtpass.assertConfigured();
    const response = await axios.get(`${config.vtpass.baseUrl}/balance`, {
      ...vtpass.authConfig('get'),
      timeout: Math.min(config.vtpass.timeoutMs, 15000),
    });
    const data = response.data || {};
    const raw = data.content?.transactions?.balance ?? data.content?.balance ?? data.balance ?? data.data?.balance;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Service catalogue (server-side source of truth). Re-uses the pricing module.
 */
function getServices() {
  const { getCatalog } = require('../services/pricing');
  return getCatalog();
}

/**
 * Variations for a provider serviceID. Delegates to the existing fetch.
 */
async function getVariations(serviceID) {
  return vtpass.fetchVariations(serviceID);
}

/**
 * Customer verification lookup (electricity meter / cable smartcard where the
 * provider supports it). Returns a normalised {name, address, ...} or null.
 * Not wired into the purchase path; exposed for the provider interface and
 * future verification UX. Returns null when unsupported/unreachable.
 */
async function verifyCustomer({ serviceType, accountNumber }) {
  const axios = require('axios');
  try {
    vtpass.assertConfigured();
    const serviceID = String(serviceType || '').toLowerCase();
    const response = await axios.post(`${config.vtpass.baseUrl}/verify`, {
      serviceID,
      billersCode: String(accountNumber || ''),
    }, {
      ...vtpass.authConfig('post'),
      timeout: Math.min(config.vtpass.timeoutMs, 15000),
    });
    const data = response.data || {};
    const content = data.content || {};
    if (!content.customer_name && !content.Name) return null;
    return {
      name: content.customer_name || content.Name || null,
      address: content.customer_address || content.Address || null,
      response: data.response_description || null,
    };
  } catch {
    return null;
  }
}

/**
 * Purchase — delegates to the existing exactly-once settlement path.
 */
async function purchase(args) {
  return vtpass.processVtpassPurchase(args);
}

/**
 * Query a transaction by its TopFlowNG request reference.
 */
async function queryTransaction(requestId) {
  return vtpass.queryVtpassOrder(requestId);
}

/**
 * Read-only provider health probe. Uses the documented service-variations
 * endpoint (requires no purchase, no secret values exposed). Cached briefly.
 */
async function healthCheck() {
  if (healthCache && Date.now() - healthCache.at < HEALTH_CACHE_TTL_MS) {
    return healthCache.result;
  }
  const started = Date.now();
  const result = await healthCheckUncached(started);
  healthCache = { at: Date.now(), result };
  return result;
}

async function healthCheckUncached(started) {
  try {
    vtpass.assertConfigured();
  } catch {
    return { status: PROVIDER_STATUS.UNAVAILABLE, reason: 'not-configured', latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
  }
  try {
    const variations = await vtpass.fetchVariations('mtn');
    const ok = Array.isArray(variations);
    return {
      status: ok ? PROVIDER_STATUS.OPERATIONAL : PROVIDER_STATUS.DEGRADED,
      latencyMs: Date.now() - started,
      checkedAt: new Date().toISOString(),
    };
  } catch {
    return { status: PROVIDER_STATUS.UNAVAILABLE, reason: 'unreachable', latencyMs: Date.now() - started, checkedAt: new Date().toISOString() };
  }
}

function isOperational() {
  return healthCheck().then((h) => h.status === PROVIDER_STATUS.OPERATIONAL).catch(() => false);
}

module.exports = {
  name: 'vtpass',
  PROVIDER_STATUS,
  getBalance,
  getServices,
  getVariations,
  verifyCustomer,
  purchase,
  queryTransaction,
  healthCheck,
  isOperational,
};