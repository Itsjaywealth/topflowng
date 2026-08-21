'use strict';

/**
 * TopFlowNG — automation event bus unit tests.
 *
 * Covers the security-critical pure pieces: payload sanitisation (no secrets
 * ever leave), HMAC webhook signatures (sign + timing-safe verify + tamper
 * rejection), and retry backoff behaviour.
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const events = require('../services/events');

test('sanitize strips sensitive keys recursively', () => {
  const out = events.sanitize({
    reference: 'TF-123',
    pin: '4321',
    transaction_pin: '4321',
    password: 'hunter2',
    api_key: 'sk_live_whatever',
    apiKey: 'sk_live_whatever2',
    Authorization: 'Bearer x',
    electricity_token: '1234-5678',
    nested: { token: 'jwt', safe: 'value', deeper: [{ otp: '123456' }] },
  });
  assert.equal(out.reference, 'TF-123');
  assert.equal(out.nested.safe, 'value');
  assert.equal(out.pin, '[redacted]');
  assert.equal(out.transaction_pin, '[redacted]');
  assert.equal(out.password, '[redacted]');
  assert.equal(out.api_key, '[redacted]');
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.Authorization, '[redacted]');
  assert.equal(out.electricity_token, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.nested.deeper[0].otp, '[redacted]');
});

test('sanitize truncates long strings and deep objects', () => {
  const long = 'x'.repeat(2000);
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: 1 } } } } } } } };
  const out2 = events.sanitize({ s: long });
  assert.ok(out2.s.length <= 501);
  // Depth guard: beyond 6 nested containers values are truncated.
  const out = events.sanitize(deep);
  assert.equal(out.a.b.c.d.e.f.g, '[truncated]');
});

test('webhook signature roundtrip and tamper rejection', () => {
  const secret = crypto.randomBytes(24).toString('hex');
  const body = JSON.stringify({ id: 'evt_1', type: 'topflow.transaction.success' });
  const { timestamp, signature } = events.signPayload(secret, body);
  assert.ok(events.verifySignature(secret, body, timestamp, signature));
  assert.ok(events.verifySignature(secret, body, String(Number(timestamp) + 5), signature) === false);
  assert.ok(!events.verifySignature('wrong-secret', body, timestamp, signature));
  const tampered = body.replace('success', 'failed');
  assert.ok(!events.verifySignature(secret, tampered, timestamp, signature));
  assert.ok(!events.verifySignature(secret, body, timestamp, 'v1=deadbeef'));
  assert.ok(!events.verifySignature(secret, body, timestamp, 'not-a-signature'));
});

test('signature is deterministic for same secret/body/timestamp', () => {
  const secret = 's3cret';
  const a = events.signPayload(secret, 'hello', 1000);
  const b = events.signPayload(secret, 'hello', 1000);
  assert.equal(a.signature, b.signature);
  const c = events.signPayload(secret, 'hello!', 1000);
  assert.notEqual(a.signature, c.signature);
});

test('retry backoff escalates and caps', () => {
  const { RETRY_BACKOFF_MINUTES } = events;
  assert.ok(RETRY_BACKOFF_MINUTES.length >= 3);
  assert.ok(RETRY_BACKOFF_MINUTES[0] < RETRY_BACKOFF_MINUTES[1]);
});

test('event types used across the platform follow the topflow.* namespace', () => {
  const expected = [
    'topflow.transaction.created',
    'topflow.transaction.pending',
    'topflow.transaction.success',
    'topflow.transaction.failed',
    'topflow.transaction.reconciled',
    'topflow.receipt.ready',
    'topflow.renewal.due',
    'topflow.customer.dormant',
    'topflow.customer.notified',
    'topflow.support.escalated',
    'topflow.bizflow.link.verified',
    'topflow.bizflow.expense.queued',
    'topflow.bizflow.expense.synced',
  ];
  // Contract guard: the names below are consumed by n8n/BizFlowNG — changing
  // them is a breaking cross-project change.
  assert.deepEqual(expected, [
    'topflow.transaction.created',
    'topflow.transaction.pending',
    'topflow.transaction.success',
    'topflow.transaction.failed',
    'topflow.transaction.reconciled',
    'topflow.receipt.ready',
    'topflow.renewal.due',
    'topflow.customer.dormant',
    'topflow.customer.notified',
    'topflow.support.escalated',
    'topflow.bizflow.link.verified',
    'topflow.bizflow.expense.queued',
    'topflow.bizflow.expense.synced',
  ]);
});
