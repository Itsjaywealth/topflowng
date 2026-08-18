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
    assert.strictEqual(row.state, 'VALID');
  }
});

// Guards the structural invariant that made every Data/Cable plan UNMAPPED:
// PRODUCT_MAP must be keyed by the flat plan code, never nested by network.
test('every Data and Cable plan in the customer catalogue is mapped and enabled', () => {
  const rows = getProductRegistry();
  const byId = Object.fromEntries(rows.map((r) => [r.internalId, r]));
  const checks = [
    ...DATA_PLANS.MTN.map((p) => p.code),
    ...DATA_PLANS.GLO.map((p) => p.code),
    ...DATA_PLANS.AIRTEL.map((p) => p.code),
    ...DATA_PLANS['9MOBILE'].map((p) => p.code),
    ...CABLE_PLANS.DSTV.map((p) => p.code),
    ...CABLE_PLANS.GOTV.map((p) => p.code),
    ...CABLE_PLANS.STARTIMES.map((p) => p.code),
  ];
  for (const code of checks) {
    const row = byId[code];
    assert.ok(row, `registry missing plan ${code}`);
    assert.strictEqual(row.enabled, true, `${code} must be enabled`);
    assert.strictEqual(row.state, 'VALID', `${code} must be VALID (not ${row.state})`);
    assert.ok(row.variation, `${code} must have a provider variation`);
    assert.strictEqual(row.customerUiState, 'enabled', `${code} must be customer-visible`);
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