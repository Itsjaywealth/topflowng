/**
 * TopFlowNG — provider registry.
 *
 * The owned application routes utility fulfillment through a provider
 * abstraction. Today only VTPass is configured; a secondary provider can be
 * added behind the same interface without redesigning the application.
 *
 * Automatic failover is deliberately NOT enabled: pricing, balances, service
 * mappings, idempotency and reconciliation must be proven for a second
 * provider before it can be offered as a routing target.
 */

'use strict';

const vtpass = require('./vtpass');

// Configured providers, in routing-preference order.
const PROVIDERS = [vtpass];

/** Return the primary (and currently only) provider adapter. */
function primaryProvider() {
  return PROVIDERS[0] || null;
}

/** Names of all configured providers. */
function providerNames() {
  return PROVIDERS.map((p) => p.name);
}

module.exports = { PROVIDERS, primaryProvider, providerNames }; 