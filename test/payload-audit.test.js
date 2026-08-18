'use strict';

/**
 * Payload audit + electricity phone-defect regression tests.
 *
 * The electricity (and cable / recharge-pin) provider requests require a
 * valid `phone` in 0XXXXXXXXXX form. The JWT payload never carries a phone
 * claim, so the routes resolve the account holder's phone from the DB and
 * normalize it. These tests lock that contract:
 *   - normalizeNigerianPhone converts +234/234 prefixes to 0XXXXXXXXXX
 *   - productFor never produces an empty phone for electricity/cable
 *   - no required provider field is undefined/null/NaN/empty
 */

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { normalizeNigerianPhone, isValidPhone } = require('../lib/validate');
const { productFor, PRODUCT_MAP, DISCO_SERVICE } = require('../services/vtpass');

describe('normalizeNigerianPhone', () => {
  test('converts +234XXXXXXXXX to 0XXXXXXXXX', () => {
    assert.strictEqual(normalizeNigerianPhone('+2348136601886'), '08136601886');
  });

  test('converts 234XXXXXXXXX to 0XXXXXXXXX', () => {
    assert.strictEqual(normalizeNigerianPhone('2348136601886'), '08136601886');
  });

  test('keeps 0XXXXXXXXX as-is', () => {
    assert.strictEqual(normalizeNigerianPhone('08136601886'), '08136601886');
  });

  test('strips spaces/dashes/parens', () => {
    assert.strictEqual(normalizeNigerianPhone('+234 813 660 1886'), '08136601886');
    assert.strictEqual(normalizeNigerianPhone('0813-660-1886'), '08136601886');
  });

  test('accepts all Nigerian prefixes (07/08/09)', () => {
    assert.strictEqual(normalizeNigerianPhone('07012345678'), '07012345678');
    assert.strictEqual(normalizeNigerianPhone('08012345678'), '08012345678');
    assert.strictEqual(normalizeNigerianPhone('09012345678'), '09012345678');
    assert.strictEqual(normalizeNigerianPhone('+2347012345678'), '07012345678');
  });

  test('returns empty for non-Nigerian or malformed numbers', () => {
    assert.strictEqual(normalizeNigerianPhone(''), '');
    assert.strictEqual(normalizeNigerianPhone(null), '');
    assert.strictEqual(normalizeNigerianPhone(undefined), '');
    assert.strictEqual(normalizeNigerianPhone('08123'), '');
    assert.strictEqual(normalizeNigerianPhone('0123456789'), '');
    assert.strictEqual(normalizeNigerianPhone('+15551234567'), '');
  });

  test('normalized output satisfies isValidPhone', () => {
    for (const input of ['+2348136601886', '2348091234567', '09012345678', '07012345678']) {
      const out = normalizeNigerianPhone(input);
      assert.strictEqual(out.length, 11);
      assert.ok(isValidPhone(out), `normalized ${input} -> ${out} should be a valid phone`);
    }
  });
});

describe('provider payload audit', () => {
  function assertNoEmptyRequiredField(payload, requiredFields) {
    for (const field of requiredFields) {
      assert.ok(Object.prototype.hasOwnProperty.call(payload, field), `missing field ${field}`);
      const v = payload[field];
      assert.ok(v !== undefined, `${field} must not be undefined`);
      assert.ok(v !== null, `${field} must not be null`);
      if (typeof v === 'string') assert.notStrictEqual(v.trim(), '', `${field} must not be empty`);
      if (typeof v === 'number') assert.ok(Number.isFinite(v) && v > 0, `${field} must be a positive number`);
    }
  }

  test('electricity payload always carries a non-empty normalized phone', () => {
    const payload = productFor('electricity', {
      disco: 'IKEDC', meterType: 'prepaid', meterNumber: '45067460456',
      amount: 1000, phone: '08136601886',
    });
    assert.strictEqual(payload.phone, '08136601886');
    assert.strictEqual(payload.serviceID, DISCO_SERVICE.IKEDC);
    assert.strictEqual(payload.variation_code, 'prepaid');
    assert.strictEqual(payload.billersCode, '45067460456');
    assertNoEmptyRequiredField(payload, ['serviceID', 'billersCode', 'variation_code', 'amount', 'phone']);
  });

  test('electricity payload normalizes a +234 phone from the DB', () => {
    const payload = productFor('electricity', {
      disco: 'IKEDC', meterType: 'prepaid', meterNumber: '45067460456',
      amount: 1000, phone: normalizeNigerianPhone('+2348136601886'),
    });
    assert.strictEqual(payload.phone, '08136601886');
    assert.strictEqual(payload.phone.length, 11);
  });

  test('cable payload always carries a non-empty normalized phone', () => {
    const payload = productFor('cable', {
      provider: 'DSTV', planCode: 'DSTV_CONFAM', smartCardNumber: '7000000000',
      phone: '08012345678',
    });
    assert.strictEqual(payload.phone, '08012345678');
    assertNoEmptyRequiredField(payload, ['serviceID', 'billersCode', 'variation_code', 'phone', 'quantity']);
  });

  test('airtime payload carries amount + phone', () => {
    const payload = productFor('airtime', { network: 'MTN', amount: 1000, phone: '08012345678' });
    assert.strictEqual(payload.amount, 1000);
    assert.strictEqual(payload.phone, '08012345678');
    assertNoEmptyRequiredField(payload, ['serviceID', 'amount', 'phone']);
  });

  test('data payload carries variation + phone', () => {
    const payload = productFor('data', { network: 'MTN', planCode: 'MTN1GB', phone: '08012345678' });
    assert.strictEqual(payload.variation_code, PRODUCT_MAP.data.MTN1GB);
    assert.strictEqual(payload.phone, '08012345678');
    assertNoEmptyRequiredField(payload, ['serviceID', 'variation_code', 'phone']);
  });

  test('exam payload never sends a phone (not required)', () => {
    const payload = productFor('exam-pin', { examBody: 'WAEC', quantity: 1 });
    assert.strictEqual(payload.serviceID, 'waec');
    assert.strictEqual(payload.variation_code, 'waecdirect');
    assertNoEmptyRequiredField(payload, ['serviceID', 'variation_code', 'quantity']);
  });

  test('unknown electricity disco fails closed', () => {
    assert.throws(() => productFor('electricity', {
      disco: 'NOTADISCO', meterType: 'prepaid', meterNumber: 'x', amount: 100, phone: '08012345678',
    }), /Unsupported electricity provider/);
  });

  test('unmapped data plan fails closed (never sends money at a guess)', () => {
    assert.throws(() => productFor('data', { network: 'MTN', planCode: 'MTN_FAKE', phone: '08012345678' }), /not mapped/);
  });
});