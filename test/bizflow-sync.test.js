'use strict';

/**
 * TopFlowNG — BizFlowNG sync service unit tests.
 *
 * Covers secret encryption at rest (AES-256-GCM roundtrip + tamper rejection)
 * and key fingerprinting. No database required.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-for-automation-suite';
const bizflow = require('../services/bizflow-sync');

test('api key encryption roundtrip never returns plaintext', () => {
  const key = 'bizflow_sk_test_1234567890abcdef';
  const enc = bizflow.encryptSecret(key);
  assert.ok(!enc.includes(key));
  assert.equal(enc.split('.').length, 3); // iv.tag.ciphertext
  assert.equal(bizflow.decryptSecret(enc), key);
});

test('tampered ciphertext fails to decrypt', () => {
  const enc = bizflow.encryptSecret('another-test-key-9876543210');
  const [iv, tag, ct] = enc.split('.');
  const flipped = Buffer.from(ct, 'base64');
  flipped[0] ^= 0xff;
  const tampered = `${iv}.${tag}.${flipped.toString('base64')}`;
  assert.throws(() => bizflow.decryptSecret(tampered));
});

test('different keys produce different ciphertexts (random IV)', () => {
  const a = bizflow.encryptSecret('same-input-key-1234567890');
  const b = bizflow.encryptSecret('same-input-key-1234567890');
  assert.notEqual(a, b);
});

test('fingerprint is stable, short, and key-specific', () => {
  const f1 = bizflow.fingerprint('key-one-abcdefghijklmnop');
  const f2 = bizflow.fingerprint('key-one-abcdefghijklmnop');
  const f3 = bizflow.fingerprint('key-two-abcdefghijklmnop');
  assert.equal(f1, f2);
  assert.notEqual(f1, f3);
  assert.ok(f1.length === 12);
});
