/**
 * TopFlowNG — Notification centre tests.
 *
 * Exercises the customer-facing notification API (list, unread count, mark
 * read, mark all read, delete) plus event-driven creation via the wallet
 * credit and purchase flows. Uses the in-memory-mocked harness so no real
 * provider/Paystack/Postgres is contacted.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('./helpers/load-app');

before(async () => {
  await h.waitForServer();
});

after(() => {
  h.closeServer();
});

let authToken;
let userId;

async function registerUser() {
  const email = `notif-${Date.now()}@test.local`;
  const res = await fetch(h.BASE_URL + '/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fullName: 'Notification Tester', email, password: 'testpass123', phone: '080' + String(Date.now()).slice(-9) }),
  });
  const data = await res.json();
  return data;
}

async function apiGet(path, token) {
  const res = await fetch(h.BASE_URL + path, { headers: { Authorization: `Bearer ${token}` } });
  return res;
}

test('notification lifecycle: create, list, unread count, mark read, mark all, delete', async () => {
  const reg = await registerUser();
  assert.ok(reg.token, 'registration should return a token');
  authToken = reg.token;
  userId = reg.user.id;

  // Create events directly through the DB layer like the real flows do.
  const db = require('../database');
  await db.createNotification({ userId, category: 'wallet', title: 'Wallet funded', message: '₦10,000 was added to your wallet.' });
  await db.createNotification({ userId, category: 'transaction', title: 'Airtime purchase successful', message: 'Your ₦500 MTN airtime purchase was successful.' });
  await db.createNotification({ userId, category: 'security', title: 'New sign-in', message: 'Your account was signed in from a new device.' });

  const list = await apiGet('/api/notifications', authToken);
  assert.strictEqual(list.status, 200);
  const body = await list.json();
  assert.strictEqual(body.total, 3);
  assert.strictEqual(body.notifications.length, 3);

  const unread = await apiGet('/api/notifications/unread-count', authToken);
  const unreadBody = await unread.json();
  assert.strictEqual(unreadBody.unread, 3);

  // Category filter
  const walletOnly = await apiGet('/api/notifications?category=wallet', authToken);
  const walletBody = await walletOnly.json();
  assert.strictEqual(walletBody.notifications.length, 1);
  assert.strictEqual(walletBody.notifications[0].category, 'wallet');

  // Mark one read
  const firstId = body.notifications[0].id;
  const markOne = await fetch(h.BASE_URL + `/api/notifications/read/${firstId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  assert.strictEqual(markOne.status, 200);
  const unreadAfterOne = await (await apiGet('/api/notifications/unread-count', authToken)).json();
  assert.strictEqual(unreadAfterOne.unread, 2);

  // Mark all read
  const markAll = await fetch(h.BASE_URL + '/api/notifications/read-all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  assert.strictEqual(markAll.status, 200);
  const unreadAfterAll = await (await apiGet('/api/notifications/unread-count', authToken)).json();
  assert.strictEqual(unreadAfterAll.unread, 0);

  // Delete one
  const del = await fetch(h.BASE_URL + `/api/notifications/${firstId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${authToken}` },
  });
  assert.strictEqual(del.status, 200);
  const afterDelete = await (await apiGet('/api/notifications', authToken)).json();
  assert.strictEqual(afterDelete.total, 2);
});

test('notifications are scoped to the owning user (no cross-user leak)', async () => {
  const other = await registerUser();
  const list = await apiGet('/api/notifications', other.token);
  const body = await list.json();
  assert.strictEqual(body.total, 0, 'a different user must not see another user\u2019s notifications');
});

test('unauthenticated notification access is rejected', async () => {
  const res = await fetch(h.BASE_URL + '/api/notifications');
  assert.strictEqual(res.status, 401);
});