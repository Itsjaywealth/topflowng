/**
 * TopFlowNG — BizFlow route tests (real server + throwaway Postgres).
 *
 * Covers the authenticated bizflow data document (get/put round-trip) and the
 * invoice-by-email flow against the REAL database and routes, with only the
 * email/provider layers mocked via the idempotency harness.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/load-idempotency-app');

let db;
let token;

function makeClient(overrides = {}) {
  return {
    id: 'c' + Date.now() + Math.floor(Math.random() * 1000),
    name: 'Acme Ltd',
    email: 'billing@acme.test',
    phone: '08031234567',
    address: 'Marina, Lagos',
    industry: 'Technology',
    status: 'active',
    created: new Date().toISOString(),
    ...overrides,
  };
}

function makeInvoice(client) {
  return {
    id: 1001,
    clientId: client.id,
    clientName: client.name,
    items: [{ desc: 'Consulting', qty: 1, price: 5000 }],
    subtotal: 5000,
    vat: 375,
    total: 5375,
    status: 'draft',
    notes: 'Payment due in 30 days',
    due: '2026-09-30',
    created: new Date().toISOString(),
  };
}

before(async () => {
  db = require('../database');
  await h.waitForServer();
  h.applyMigrations();

  const reg = await h.api('POST', '/api/auth/register', {
    body: { fullName: 'Biz Test', email: 'biztest' + process.pid + '@example.com', phone: '08090000007', password: 'secret123' },
  });
  assert.strictEqual(reg.status, 201);
  token = reg.data.token;
});

after(async () => {
  await h.cleanup();
});

test('bizflow data document round-trips per user', async () => {
  const doc = {
    invoices: [makeInvoice(makeClient())],
    clients: [makeClient()],
    staff: [],
    invoiceCounter: 1002,
    payrollPaid: { '2026-08': { s1: 'paid' } },
    payrollProcessed: { '2026-08': true },
  };
  const put = await h.api('PUT', '/api/bizflow/data', { body: doc, token });
  assert.strictEqual(put.status, 200);
  assert.strictEqual(put.data.saved, true);

  const get = await h.api('GET', '/api/bizflow/data', { token });
  assert.strictEqual(get.status, 200);
  assert.strictEqual(get.data.data.invoiceCounter, 1002);
  assert.strictEqual(get.data.data.invoices[0].total, 5375);
  assert.deepStrictEqual(get.data.data.payrollProcessed, { '2026-08': true });
});

test('bizflow data requires auth', async () => {
  const put = await h.api('PUT', '/api/bizflow/data', { body: { invoices: [] } });
  assert.strictEqual(put.status, 401);
  const get = await h.api('GET', '/api/bizflow/data');
  assert.strictEqual(get.status, 401);
});

test('invoice send emails the client and marks it sent', async () => {
  h.emailState.reset();
  const client = makeClient();
  const inv = makeInvoice(client);
  await h.api('PUT', '/api/bizflow/data', {
    token,
    body: { invoices: [inv], clients: [client], staff: [], invoiceCounter: 1002, payrollPaid: {}, payrollProcessed: {} },
  });

  const send = await h.api('POST', `/api/bizflow/invoices/${inv.id}/send`, { token });
  assert.strictEqual(send.status, 200);
  assert.strictEqual(send.data.status, 'sent');

  assert.strictEqual(h.emailState.invoiceCalls.length, 1);
  const call = h.emailState.invoiceCalls[0]; // [clientEmail, { invoice, client, ... }]
  const clientEmail = call[0];
  const payload = call[1];
  assert.strictEqual(clientEmail, 'billing@acme.test');
  assert.strictEqual(payload.invoice.id, inv.id);
  assert.ok(payload.invoice.items.length === 1);

  const get = await h.api('GET', '/api/bizflow/data', { token });
  assert.strictEqual(get.data.data.invoices[0].status, 'sent', 'status persisted');
});

test('invoice send rejects a client without email', async () => {
  h.emailState.reset();
  const client = makeClient({ email: '', name: 'NoEmail Co' });
  const inv = makeInvoice(client);
  inv.clientName = 'NoEmail Co';
  await h.api('PUT', '/api/bizflow/data', {
    token,
    body: { invoices: [inv], clients: [client], staff: [], invoiceCounter: 1003, payrollPaid: {}, payrollProcessed: {} },
  });

  const send = await h.api('POST', `/api/bizflow/invoices/${inv.id}/send`, { token });
  assert.strictEqual(send.status, 400);
  assert.strictEqual(h.emailState.invoiceCalls.length, 0);
});

test('invoice send 404s for an unknown invoice', async () => {
  const send = await h.api('POST', '/api/bizflow/invoices/999999/send', { token });
  assert.strictEqual(send.status, 404);
});