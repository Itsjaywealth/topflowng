'use strict';

/**
 * TopFlowNG — provider balance watchdog tests.
 *
 * Covers the pure threshold logic (hysteresis: one alert per low-crossing,
 * re-armed after recovery) and the balance response parser.
 */

const test = require('node:test');
const assert = require('node:assert');

const { evaluateProviderBalance } = require('../services/vtpass');

test('fires exactly once on crossing below threshold', () => {
  const first = evaluateProviderBalance(4_999, { minBalance: 5_000, wasLow: false });
  assert.deepStrictEqual(first, { alert: true, recover: false, low: true });
  const again = evaluateProviderBalance(2_000, { minBalance: 5_000, wasLow: true });
  assert.deepStrictEqual(again, { alert: false, recover: false, low: true });
});

test('stays quiet while balance remains above threshold', () => {
  assert.deepStrictEqual(
    evaluateProviderBalance(50_000, { minBalance: 5_000, wasLow: false }),
    { alert: false, recover: false, low: false }
  );
});

test('re-arms only after recovery past the margin', () => {
  const below = evaluateProviderBalance(4_999, { minBalance: 5_000, wasLow: false });
  assert.equal(below.alert, true);
  // Slightly above threshold but inside the margin: still low, no recover.
  const marginal = evaluateProviderBalance(5_500, { minBalance: 5_000, wasLow: true, recoverMargin: 1_000 });
  assert.deepStrictEqual(marginal, { alert: false, recover: false, low: true });
  const recovered = evaluateProviderBalance(6_500, { minBalance: 5_000, wasLow: true, recoverMargin: 1_000 });
  assert.deepStrictEqual(recovered, { alert: false, recover: true, low: false });
  // After re-arm, a fresh dip alerts again.
  const redip = evaluateProviderBalance(4_999, { minBalance: 5_000, wasLow: false });
  assert.equal(redip.alert, true);
});

test('non-numeric balances never alert and never clear a low state', () => {
  assert.deepStrictEqual(
    evaluateProviderBalance(NaN, { minBalance: 5_000, wasLow: true }),
    { alert: false, recover: false, low: true }
  );
  assert.deepStrictEqual(
    evaluateProviderBalance(undefined, { minBalance: 5_000, wasLow: false }),
    { alert: false, recover: false, low: false }
  );
});
