'use strict';

/**
 * TopFlowNG — provider catalogue sync tests (pure reconciliation logic).
 */

const test = require('node:test');
const assert = require('node:assert');

const { reconcileGroup } = require('../services/catalog-sync');

const LIVE = [
  { variation_code: 'mtn-1gb', variation_amount: 490 },
  { variation_code: 'mtn-2gb', variation_amount: 990 },
  { variation_code: 'mtn-new-20gb', variation_amount: 6000 },
];

test('healthy plan classifies OK with provider cost', () => {
  const rows = reconcileGroup('data:MTN',
    [{ code: 'mtn-1gb', retail: 800 }],
    LIVE);
  const hit = rows.find((r) => r.code === 'mtn-1gb');
  assert.equal(hit.state, 'OK');
  assert.equal(hit.providerCost, 490);
});

test('delisted plan is MISSING_AT_PROVIDER', () => {
  const rows = reconcileGroup('data:MTN',
    [{ code: 'mtn-gone', retail: 1800 }],
    LIVE);
  const hit = rows.find((r) => r.code === 'mtn-gone');
  assert.equal(hit.state, 'MISSING_AT_PROVIDER');
});

test('retail below provider cost is PRICE_BELOW_COST', () => {
  const rows = reconcileGroup('data:MTN',
    [{ code: 'mtn-1gb', retail: 300 }],
    LIVE);
  const hit = rows.find((r) => r.code === 'mtn-1gb');
  assert.equal(hit.state, 'PRICE_BELOW_COST');
  assert.equal(hit.providerCost, 490);
});

test('provider-only plans surface as NEW_AT_PROVIDER', () => {
  const rows = reconcileGroup('data:MTN', [], LIVE);
  const fresh = rows.filter((r) => r.state === 'NEW_AT_PROVIDER');
  assert.equal(fresh.length, 3);
});

test('exact-price plans are OK, not below cost', () => {
  const rows = reconcileGroup('data:MTN',
    [{ code: 'mtn-2gb', retail: 990 }],
    LIVE);
  assert.equal(rows[0].state, 'OK');
});
