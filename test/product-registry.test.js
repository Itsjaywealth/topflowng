'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DATA_PLANS, CABLE_PLANS, EXAM_PRODUCTS } = require('../services/pricing');
const { getProductRegistry } = require('../services/vtpass');

test('canonical product registry contains no enabled unmapped product', () => {
  const rows = getProductRegistry();
  assert.ok(rows.length > 0);
  for (const row of rows.filter((item) => item.enabled)) {
    assert.ok(row.serviceId, `${row.internalId} needs a provider service ID`);
    if (['Data', 'Cable', 'Exam'].includes(row.category)) {
      assert.ok(row.variation, `${row.internalId} needs a provider variation`);
    }
    assert.strictEqual(row.customerUiState, 'enabled');
  }
});

test('verified VTPass snapshot values are the values enforced at checkout', () => {
  assert.equal(DATA_PLANS.MTN.find((p) => p.code === 'MTN20GB').price, 7500);
  assert.equal(DATA_PLANS.GLO.find((p) => p.code === 'GLO1GB').price, 495);
  assert.equal(CABLE_PLANS.DSTV.find((p) => p.code === 'DSTV_PREMIUM').price, 44500);
  assert.equal(CABLE_PLANS.GOTV.find((p) => p.code === 'GOTV_JOLLI').price, 5800);
  assert.equal(CABLE_PLANS.STARTIMES.find((p) => p.code === 'ST_SUPER').price, 9800);
  assert.equal(EXAM_PRODUCTS.WAEC.price, 5350);
  assert.equal(EXAM_PRODUCTS.JAMB.enabled, false);
});
