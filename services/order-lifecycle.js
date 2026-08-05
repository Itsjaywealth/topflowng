'use strict';

/**
 * TopFlowNG — VTU order status transition matrix (Phase 4E).
 *
 * Single source of truth for which status changes are legal. Centralises:
 *   - the initial (submitted) and terminal (completed / failed) state model,
 *   - the list of allowed forward transitions,
 *   - idempotent same-state re-entry (completed → completed, failed → failed…),
 *   - rejection of ambiguous or unsafe transitions (e.g. completed → failed),
 *   - guaranteed-to-be-invalid transitions, surfaced with a clear reason
 *     instead of relying on each caller to remember the rules.
 *
 * The schema does NOT have a `processing` state today. It was considered out
 * of scope for Phase 4E (would require a migration + frontend change); the
 * matrix below deliberately omits it so any attempt to move an order through a
 * non-existent state fails loudly at the transition-layer rather than being
 * silently ignored.
 */

const INITIAL_STATUS = 'submitted';

const TERMINAL = new Set(['completed', 'failed']);

// Allowed forward transitions from each state. Same-state (idempotent)
// transitions are permitted for every state handled below.
const ALLOWED = Object.freeze({
  submitted: ['pending', 'completed', 'failed'],
  pending: ['completed', 'failed'],
  completed: [],
  failed: [],
});

const VALID_STATUSES = new Set(['submitted', 'pending', 'completed', 'failed']);

/**
 * Generates a human-readable reason for an invalid transition.
 */
function invalidReason(from, to) {
  const reason =
    from === 'completed' || from === 'failed'
      ? `${from} is a terminal state; it cannot move to ${to}.`
      : `Illegal VTU order transition ${from} → ${to}.`;
  // Reconcile path helper text is never echoed verbatim to the client.
  return reason;
}

/**
 * A transition error carrying a recommended HTTP status for callers that want
 * to surface it, without leaking provider internals.
 */
class TransitionError extends Error {
  constructor(from, to, status = 409) {
    super(invalidReason(from, to));
    this.name = 'TransitionError';
    this.from = from;
    this.to = to;
    this.status = status;
  }
}

/**
 * Returns true if (current → next) is allowed, including idempotent
 * same-state transitions.
 */
function canTransition(current, next) {
  if (!VALID_STATUSES.has(current) || !VALID_STATUSES.has(next)) return false;
  if (current === next) return true; // idempotent re-apply of the same status
  return ALLOWED[current].includes(next);
}

/**
 * Throws a TransitionError when the requested change is not permitted.
 * Idempotent same-state calls return true (they are safe no-ops).
 *
 * @param {string} current   current stored status
 * @param {string} next      requested status
 * @param {number} [status]  optional HTTP status for the raised error
 */
function assertCanTransition(current, next, status) {
  if (canTransition(current, next)) return true;
  throw new TransitionError(current, next, status);
}

module.exports = {
  INITIAL_STATUS,
  TERMINAL,
  VALID_STATUSES,
  canTransition,
  assertCanTransition,
  TransitionError,
};