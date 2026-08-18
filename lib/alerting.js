/**
 * TopFlowNG — Internal structured alerting with deduplication/cooldowns.
 *
 * Purpose: surface operational conditions (provider down, DB unavailable,
 * low VTPass balance, webhook failures, unusual 5xx, stale pending, background
 * job failure) as cooldown-gated, structured log events. These are consumed by
 * the operations center, log aggregation, and alerting viewers.
 *
 * No paid monitoring service is used. Deduplication prevents alert storms: each
 * named condition fires at most once per cooldown window (default 5 minutes).
 * When the condition clears, a 'resolved' event is emitted so operators see
 * recovery.
 */

'use strict';

const logger = require('./logger');

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

// condition -> { firedAt, active }
const state = new Map();

/**
 * Raise or clear an operational condition.
 *
 * @param {object} opts
 * @param {string} opts.name   stable identifier, e.g. 'vtpass_unreachable'
 * @param {boolean} opts.active whether the condition is currently present
 * @param {string} [opts.severity] info|warn|error (default 'warn')
 * @param {object} [opts.fields] structured context (redacted by the logger)
 * @param {number} [opts.cooldownMs] override cooldown
 */
function condition(opts) {
  const name = String(opts.name || 'unknown_condition');
  const cooldownMs = opts.cooldownMs || DEFAULT_COOLDOWN_MS;
  const now = Date.now();
  const rec = state.get(name) || { firedAt: 0, active: false };

  const severity = opts.severity || (opts.active ? 'warn' : 'info');

  if (opts.active && !rec.active) {
    // New or re-armed condition — only fire if the cooldown has elapsed.
    if (now - rec.firedAt >= cooldownMs) {
      logger[severity](`ALERT ${name}`, { alert: name, active: true, ...(opts.fields || {}) });
      rec.firedAt = now;
    }
    rec.active = true;
  } else if (!opts.active && rec.active) {
    // Condition cleared — always report recovery.
    logger.info(`ALERT CLEARED ${name}`, { alert: name, active: false, ...(opts.fields || {}) });
    rec.active = false;
    rec.firedAt = 0;
  }

  state.set(name, rec);
}

/**
 * Snapshot of all currently-active conditions (for the ops center / status).
 */
function activeConditions() {
  const out = {};
  for (const [name, rec] of state) {
    if (rec.active) out[name] = true;
  }
  return out;
}

/** Reset internal state (tests). */
function reset() {
  state.clear();
}

module.exports = { condition, activeConditions, reset, DEFAULT_COOLDOWN_MS };
