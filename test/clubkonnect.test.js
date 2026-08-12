/**
 * TopFlowNG — Clubkonnect provider response normalisation unit tests.
 *
 * These run against the REAL clubkonnect module (no mock injected) so the
 * orderId / status extraction logic is exercised directly against provider
 * response shapes. No network, no database — pure function coverage.
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { normalizeClubkonnectResponse } = require('../services/clubkonnect');

test('snaps provider order reference from ordernumber (Nellobyte lowercase)', () => {
  const out = normalizeClubkonnectResponse({
    statuscode: 199,
    status: 'ORDER_RECEIVED',
    ordernumber: 'NB-883112',
    remark: 'On hold',
  });
  assert.strictEqual(out.outcome, 'pending');
  assert.strictEqual(out.orderId, 'NB-883112');
});

test('snaps provider order reference from OrderNumber (capitalised variant)', () => {
  const out = normalizeClubkonnectResponse({
    statuscode: 199,
    status: 'ORDER_RECEIVED',
    OrderNumber: 'CK-443210',
    remark: 'Wait',
  });
  assert.strictEqual(out.outcome, 'pending');
  assert.strictEqual(out.orderId, 'CK-443210');
});

test('snaps provider order reference from order_id snake_case variant', () => {
  const out = normalizeClubkonnectResponse({
    statuscode: 199,
    status: 'ORDER_RECEIVED',
    order_id: 'SN-771199',
    remark: 'On hold',
  });
  assert.strictEqual(out.outcome, 'pending');
  assert.strictEqual(out.orderId, 'SN-771199');
});

test('rejects placeholder order references (0, empty, undefined)', () => {
  const zero = normalizeClubkonnectResponse({ statuscode: 199, status: 'ORDER_RECEIVED', ordernumber: 0, remark: 'On hold' });
  assert.strictEqual(zero.outcome, 'pending');
  assert.strictEqual(zero.orderId, null);

  const blank = normalizeClubkonnectResponse({ statuscode: 199, status: 'ORDER_RECEIVED', ordernumber: '', remark: 'On hold' });
  assert.strictEqual(blank.outcome, 'pending');
  assert.strictEqual(blank.orderId, null);

  const undef = normalizeClubkonnectResponse({ statuscode: 199, status: 'ORDER_RECEIVED', ordernumber: 'undefined', remark: 'On hold' });
  assert.strictEqual(undef.outcome, 'pending');
  assert.strictEqual(undef.orderId, null);
});

test('orders with a captured reference become traceable (provider_order_id persisted)', () => {
  const out = normalizeClubkonnectResponse({ statuscode: 200, status: 'ORDER_COMPLETED', ordernumber: 'T-500111', remark: 'Done' });
  assert.strictEqual(out.outcome, 'success');
  assert.strictEqual(out.orderId, 'T-500111');
});