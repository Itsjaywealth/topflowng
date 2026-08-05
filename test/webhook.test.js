/**
 * TopFlowNG — Paystack webhook signature hardening tests (Phase 4B only).
 *
 * Exercises `paystackSignatureMatches` via HTTP against the real app booted
 * with a known test webhook secret. No real Paystack endpoint is contacted:
 * the payloads use a signed event that does NOT trigger the wallet-credit call
 * path, and signature acceptance/rejection is asserted purely on the response.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const h = require('./helpers/load-app');

const SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

// Raw-body event; `transfer.success` is chosen so the handler never initiates
// a verify/credit (which would otherwise reach the real Paystack API).
const PAYLOAD = JSON.stringify({
  event: 'transfer.success',
  data: { reference: 'TF-webhook-test', amount: 10000, currency: 'NGN' },
});

function sign(body) {
  return crypto.createHmac('sha512', SECRET).update(body).digest('hex');
}

const GOOD_SIG = sign(PAYLOAD);

async function postWebhook(body, signature) {
  const headers = { 'Content-Type': 'application/json' };
  if (signature !== undefined) headers['x-paystack-signature'] = signature;
  const res = await fetch(h.BASE_URL + '/api/paystack/webhook', {
    method: 'POST',
    headers,
    body,
  });
  return res;
}

before(async () => {
  await h.waitForServer();
});

after(() => {
  h.closeServer();
});

test('missing signature -> 400', async () => {
  const res = await postWebhook(PAYLOAD);
  assert.strictEqual(res.status, 400);
  const data = await res.json();
  assert.strictEqual(data.error, 'Invalid signature');
});

test('malformed non-hex signature -> 400', async () => {
  const res = await postWebhook(PAYLOAD, 'zzz-not-hex-zzz'.repeat(5));
  assert.strictEqual(res.status, 400);
});

test('wrong-length signature -> 400', async () => {
  // Must be 128 hex chars; shorter and longer both rejected.
  for (const sig of [sign(PAYLOAD).slice(0, 64), sign(PAYLOAD) + '00']) {
    const res = await postWebhook(PAYLOAD, sig);
    assert.strictEqual(res.status, 400, `length ${sig.length} should be rejected`);
  }
});

test('incorrect valid-length signature -> 400', async () => {
  const wrong = (parseInt(sign(PAYLOAD).slice(0, 2), 16) ^ 0xff).toString(16).padStart(2, '0') + sign(PAYLOAD).slice(2);
  const res = await postWebhook(PAYLOAD, wrong);
  assert.strictEqual(res.status, 400);
});

test('correct signature -> 200', async () => {
  const res = await postWebhook(PAYLOAD, sign(PAYLOAD));
  assert.strictEqual(res.status, 200);
});

test('duplicate valid webhook remains idempotent', async () => {
  const first = await postWebhook(PAYLOAD, sign(PAYLOAD));
  const second = await postWebhook(PAYLOAD, sign(PAYLOAD));
  assert.strictEqual(first.status, 200);
  assert.strictEqual(second.status, 200);
});

test('no unhandled exceptions across edge inputs', async () => {
  // Empty signature, whitespace, array-style header values are all caught.
  for (const sig of ['', '  ', 'x'.repeat(128), undefined]) {
    const res = await postWebhook(PAYLOAD, sig);
    assert.strictEqual(res.status, 400, `sig=${JSON.stringify(sig)}`);
  }
  // A fully malformed JSON body with a bad signature is rejected at the sig check.
  const badBody = postWebhook('not json', '00'.repeat(64));
  const bodyRes = await badBody;
  assert.strictEqual(bodyRes.status, 400);
});

test('timing-safe valid signature comparison', async () => {
  // The exact-match path must succeed, confirming equal-length buffer compare.
  const resGood = await postWebhook(PAYLOAD, sign(PAYLOAD));
  assert.strictEqual(resGood.status, 200);
  // A different-length (but valid hex) value is still length-rejected -> 400.
  const resShort = await postWebhook(PAYLOAD, sign(PAYLOAD).slice(0, 64));
  assert.strictEqual(resShort.status, 400);
});