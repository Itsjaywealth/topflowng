/**
 * TopFlowNG — SMS service (Termii) tests.
 *
 * Standalone (no Postgres, no network). Verifies:
 *   - the service is a no-op when Termii is not configured
 *   - Nigerian phone numbers normalise to the international format Termii needs
 *   - invalid/empty numbers are rejected without attempting delivery
 *   - purchase/wallet message builders produce sensible NGN text
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

process.env.NODE_ENV = 'test';
delete process.env.TERMII_API_KEY;

const config = require('../config');
const sms = require('../services/sms');

test('SMS delivery is disabled when Termii is not configured', () => {
  assert.strictEqual(sms.isSmsConfigured(), false);
});

test('unconfigured sendSms resolves to a silent skip (no throw, no network)', async () => {
  const result = await sms.sendSms('08123456789', 'Test');
  assert.strictEqual(result.sent, false);
  assert.strictEqual(result.reason, 'not-configured');
});

test('normalizePhone converts local 0-prefixed numbers to 234 format', () => {
  assert.strictEqual(sms.normalizePhone('08123456789'), '2348123456789');
  assert.strictEqual(sms.normalizePhone('+2348123456789'), '2348123456789');
  assert.strictEqual(sms.normalizePhone('2348123456789'), '2348123456789');
});

test('normalizePhone rejects empty / malformed numbers', () => {
  assert.strictEqual(sms.normalizePhone(null), null);
  assert.strictEqual(sms.normalizePhone(''), null);
  assert.strictEqual(sms.normalizePhone('1234'), null);
  assert.strictEqual(sms.normalizePhone('not-a-phone'), null);
});

test('purchaseMessage builds NGN receipts for each outcome', () => {
  assert.match(sms.purchaseMessage('airtime', 500, 'success'), /₦500/);
  assert.match(sms.purchaseMessage('airtime', 500, 'success'), /successful/);
  assert.match(sms.purchaseMessage('data', 1000, 'pending'), /pending/);
  assert.match(sms.purchaseMessage('cable', 2500, 'failed'), /could not be completed/);
});

test('walletMessage builds credit and debit text', () => {
  assert.match(sms.walletMessage(2000, 'credit'), /₦2,000/);
  assert.match(sms.walletMessage(500, 'debit'), /debited/);
});

test('valid send attempt with configured-but-fake key does not throw', async () => {
  process.env.TERMII_API_KEY = 'fake-test-key';
  delete require.cache[require.resolve('../config')];
  delete require.cache[require.resolve('../services/sms')];
  const cfg2 = require('../config');
  const sms2 = require('../services/sms');
  assert.strictEqual(cfg2.sms.termiiApiKey, 'fake-test-key');
  const result = await sms2.sendSms('08123456789', 'Test');
  assert.strictEqual(result.sent, false);
  assert.ok(result.error, 'a delivery error is reported, never thrown');
  delete process.env.TERMII_API_KEY;
});