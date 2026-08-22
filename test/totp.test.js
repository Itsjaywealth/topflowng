'use strict';

/**
 * TopFlowNG — TOTP implementation tests.
 *
 * The 6-digit vector at t=59s is pinned against an independent RFC-6238-style
 * computation (secret = ASCII '12345678901234567890').
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const totp = require('../services/totp');

// base32('12345678901234567890')
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

function referenceCode(counter) {
  const secret = Buffer.from('12345678901234567890');
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

test('base32 round-trips', () => {
  for (const bytes of [Buffer.from('hello world'), crypto.randomBytes(20), Buffer.alloc(1)]) {
    assert.ok(totp.base32Decode(totp.base32Encode(bytes)).equals(bytes));
  }
});

test('matches the pinned RFC vector', () => {
  // t=59s → counter 1 → 287082 (independently computed reference)
  assert.equal(totp.verifyTotp(RFC_SECRET, '287082', { nowMs: 59_000, window: 0 }), true);
  assert.equal(totp.verifyTotp(RFC_SECRET, referenceCode(5), { nowMs: 5 * 30_000, window: 0 }), true);
});

test('rejects wrong, malformed and stale codes', () => {
  const now = Date.now();
  const current = require('../services/totp'); // same module; compute via reference below
  void current;
  const counter = Math.floor(now / 30_000);
  assert.equal(totp.verifyTotp(RFC_SECRET, referenceCode(counter + 10), { nowMs: now }), false, 'future code outside window');
  assert.equal(totp.verifyTotp(RFC_SECRET, '000000', { nowMs: now }) && referenceCode(counter) !== '000000', false);
  assert.equal(totp.verifyTotp(RFC_SECRET, 'abc123'), false);
  assert.equal(totp.verifyTotp(RFC_SECRET, ''), false);
});

test('accepts ±1 step drift (clock skew tolerance)', () => {
  const now = Date.now();
  const counter = Math.floor(now / 30_000);
  const previous = referenceCode(counter - 1);
  if (previous !== referenceCode(counter)) {
    assert.equal(totp.verifyTotp(RFC_SECRET, previous, { nowMs: now }), true);
  }
});

test('generated secrets verify round-trip', () => {
  const secret = totp.generateSecret();
  assert.equal(secret.length, 32);
  const now = Date.now();
  const counter = Math.floor(now / 30_000);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', totp.base32Decode(secret)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  const code = String(bin % 1_000_000).padStart(6, '0');
  assert.equal(totp.verifyTotp(secret, code, { nowMs: now }), true);
});

test('secrets encrypt at rest and never round-trip as plaintext', () => {
  const secret = totp.generateSecret();
  const stored = totp.encryptSecret(secret);
  assert.ok(!stored.includes(secret), 'ciphertext must not contain the plaintext secret');
  assert.equal(totp.decryptSecret(stored), secret);
  assert.equal(totp.decryptSecret('garbage'), null);
});

test('otpauth URL carries issuer and secret', () => {
  const url = totp.otpauthUrl('owner@example.com', 'ABC234');
  assert.match(url, /^otpauth:\/\/totp\/TopFlowNG%3Aowner%40example\.com\?secret=ABC234&issuer=TopFlowNG/);
});
