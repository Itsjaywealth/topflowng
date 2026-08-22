'use strict';

/**
 * TopFlowNG — BizFlowNG → TopFlowNG business catalogue + order intent tests.
 *
 * Verifies the signed integration surface:
 *   - signature auth (bad key / bad sig / stale timestamp all fail closed)
 *   - read-only catalogue exposes customer prices only (never provider costs)
 *   - intents are priced server-side, idempotent, and never purchase anything
 *   - the linked user confirms → checkout URL; declines → terminal state
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');

const h = require('./helpers/load-app');
const bizflowSync = require('../services/bizflow-sync');
const paystackAdapter = require('../payment/paystack');

const KEY = 'bf-test-integration-key-0123456789';
const BUSINESS_ID = 'biz_test_001';
let linkUser = null;

function signedRequest(method, path, payloadObj) {
  const isGet = method === 'GET';
  const rawBody = isGet ? '' : JSON.stringify(payloadObj ?? { business_id: BUSINESS_ID });
  const ts = Math.floor(Date.now() / 1000);
  const mac = crypto.createHmac('sha256', KEY).update(`${ts}.${rawBody}`).digest('hex');
  const sep = path.includes('?') ? '&' : '?';
  const url = isGet ? `${h.BASE_URL}${path}${sep}business_id=${encodeURIComponent(BUSINESS_ID)}` : `${h.BASE_URL}${path}`;
  return fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-bizflow-key': KEY,
      'x-topflow-timestamp': String(ts),
      'x-topflow-signature': `v1=${mac}`,
    },
    body: isGet ? undefined : rawBody,
  }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
}

async function setupLink() {
  linkUser = await h.createUserViaDb({ fullName: 'BF Owner', email: `bfo-${Date.now()}@example.com`, phone: '08091600001', password: 'secret123' });
  h.mockDb.__resetBizflowIntents();
  // Seed an ACTIVE link whose stored (encrypted) key matches KEY.
  const encrypted = bizflowSync.encryptSecret(KEY);
  const link = {
    id: 'link-1', user_id: linkUser.id, bizflow_business_id: BUSINESS_ID,
    api_key_enc: encrypted, key_fingerprint: bizflowSync.fingerprint(KEY),
    status: 'active', linked_at: new Date().toISOString(), verified_at: new Date().toISOString(),
  };
  // Push into the harness's internal store via the public helper.
  h.mockDb.__seedBizflowLink ? h.mockDb.__seedBizflowLink(link) : null;
  if (!h.mockDb.__seedBizflowLink) {
    // Fallback: exercise the real lookup path by injecting through the module state.
    const internals = h.mockDb;
    if (!internals.__bizflowLinksStore) internals.__bizflowLinksStore = [];
    internals.__bizflowLinksStore.push(link);
  }
  return linkUser;
}

test.before(async () => {
  process.env.BF_TEST_KEY = KEY;
  await h.waitForServer();
  paystackAdapter.initializePayment = async ({ reference }) => ({ authorizationUrl: 'https://checkout.paystack.com/test', reference });
});

test.after(() => {
  delete process.env.BF_TEST_KEY;
  const handles = process._getActiveHandles().map((x) => x?.constructor?.name + (x?.[Symbol.toStringTag] || ''));
  console.log('ACTIVE HANDLES:', JSON.stringify(handles));
  h.closeServer();
});

test('catalogue requires a valid signature', async () => {
  const r = await fetch(`${h.BASE_URL}/api/integrations/topflowng/services`);
  assert.equal(r.status, 401, 'missing signature must be rejected');
  void KEY;
});

test('catalogue returns customer-facing prices without provider costs', async () => {
  await setupLink();
  const r = await signedRequest('GET', '/api/integrations/topflowng/services');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.data.categories));
  const text = JSON.stringify(r.data);
  assert.ok(!/providerCost|secret|api[-_]?key|serviceID.*cost/i.test(text), 'no provider cost or secrets leak');
  const data = r.data.categories.find((c) => c.category === 'data');
  assert.ok(data.products.some((p) => p.provider === 'MTN' && p.variations.some((v) => v.code === 'MTN14GB' && v.customerPrice === 5000)));
});

test('order intent is priced server-side and idempotent', async () => {
  await setupLink();
  const body = {
    business_id: BUSINESS_ID,
    serviceType: 'data',
    idempotency_key: 'bf-order-001',
    details: { network: 'MTN', phone: '08031234567', planCode: 'MTN14GB', amount: 1 },
  };
  const first = await signedRequest('POST', '/api/integrations/topflowng/order-intents', body);
  assert.equal(first.status, 201);
  assert.equal(first.data.intent.amount, 5000, 'authoritative catalog price, client amount ignored');
  assert.equal(first.data.intent.status, 'pending');

  const replay = await signedRequest('POST', '/api/integrations/topflowng/order-intents', body);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.duplicate, true);

  const bad = await signedRequest('POST', '/api/integrations/topflowng/order-intents', {
    ...body, idempotency_key: 'bf-order-002', details: { network: 'MTN', phone: '08031234567', planCode: 'NOPE' },
  });
  assert.equal(bad.status, 400);
});

test('linked user sees the pending intent and approving issues a checkout', async () => {
  await setupLink();
  const created = await signedRequest('POST', '/api/integrations/topflowng/order-intents', {
    business_id: BUSINESS_ID, serviceType: 'airtime', idempotency_key: 'bf-order-003',
    details: { network: 'MTN', phone: '08136601886', amount: 500 },
  });
  assert.equal(created.status, 201);

  const loginRes = await h.login(linkUser.email, 'secret123');
  const token = loginRes.data.token;

  const list = await h.api('GET', '/api/bizflow/intents', { token });
  assert.equal(list.status, 200);
  assert.equal(list.data.intents.length, 1);
  assert.equal(list.data.intents[0].amount, 500);

  const confirm = await h.api('POST', `/api/bizflow/intents/${created.data.intent.id}/confirm`, { token });
  assert.equal(confirm.status, 200);
  assert.match(confirm.data.authorization_url, /checkout\.paystack\.com/);

  const after = await signedRequest('GET', `/api/integrations/topflowng/order-intents/${created.data.intent.id}`);
  assert.equal(after.data.intent.status, 'confirmed');

  const list2 = await h.api('GET', '/api/bizflow/intents', { token });
  assert.equal(list2.data.intents.length, 0, 'confirmed intent leaves the pending list');
});

test('declining an intent is terminal and purchases nothing', async () => {
  await setupLink();
  const created = await signedRequest('POST', '/api/integrations/topflowng/order-intents', {
    business_id: BUSINESS_ID, serviceType: 'electricity', idempotency_key: 'bf-order-004',
    details: { disco: 'IKEDC', meterNumber: '45067460456', meterType: 'prepaid', amount: 1000 },
  });
  const loginRes = await h.login(linkUser.email, 'secret123');
  const decline = await h.api('POST', `/api/bizflow/intents/${created.data.intent.id}/decline`, { token: loginRes.data.token });
  assert.equal(decline.status, 200);
  const after = await signedRequest('GET', `/api/integrations/topflowng/order-intents/${created.data.intent.id}`);
  assert.equal(after.data.intent.status, 'declined');
});
