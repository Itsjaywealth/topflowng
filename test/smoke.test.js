/**
 * TopFlowNG — Phase 1 & 2 regression smoke tests.
 *
 * Confirms the public contracts that Phase 3 must not break:
 * - /api/health shape
 * - static allow-list serves the SPA, denies source/env/backups
 * - error responses stay { error: string }-shaped
 * - login response stays { token, user }-shaped
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

const h = require('./helpers/load-app');

const { mockDb } = h;

before(async () => {
  mockDb.__reset();
  await h.waitForServer();
});

after(() => {
  h.closeServer();
});

test('health: returns ok with timestamp', async () => {
  const res = await fetch(h.BASE_URL + '/api/health');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ok');
  assert.ok(data.ts);
});

test('static: whitelisted SPA shell is served', async () => {
  const res = await fetch(h.BASE_URL + '/topflowng.html');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('<!DOCTYPE html>'));
});

test('canonical host: www redirects to bare domain and preserves path/query', async () => {
  const res = await new Promise((resolve, reject) => {
    const request = http.get(h.BASE_URL + '/account?tab=wallet', {
      headers: { host: 'www.topflowng.com' },
    }, resolve);
    request.on('error', reject);
  });
  assert.strictEqual(res.statusCode, 308);
  assert.strictEqual(res.headers.location, 'https://topflowng.com/account?tab=wallet');
});

test('static: admin page is served', async () => {
  const res = await fetch(h.BASE_URL + '/admin.html');
  assert.strictEqual(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('TopFlowNG Admin'));
});

test('static: server.js source is not exposed', async () => {
  const res = await fetch(h.BASE_URL + '/server.js');
  assert.strictEqual(res.status, 404);
});

test('static: .env is not exposed', async () => {
  const res = await fetch(h.BASE_URL + '/.env');
  assert.strictEqual(res.status, 404);
});

test('static: backup files are not exposed', async () => {
  const res = await fetch(h.BASE_URL + '/server.js.backup-20260804-114736');
  assert.strictEqual(res.status, 404);
});

test('security: CSP header is present and allows inline + Paystack', async () => {
  const res = await fetch(h.BASE_URL + '/');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp, 'Content-Security-Policy header is set');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'unsafe-inline' https:\/\/js\.paystack\.co/);
  assert.match(csp, /script-src-attr 'unsafe-inline'/);
  assert.match(csp, /frame-src 'self' https:\/\/checkout\.paystack\.com/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'self'/);
});

test('security: security headers present', async () => {
  const res = await fetch(h.BASE_URL + '/');
  assert.ok(res.headers.get('strict-transport-security'));
  assert.ok(res.headers.get('x-content-type-options'));
  assert.ok(res.headers.get('x-frame-options'));
  assert.ok(res.headers.get('referrer-policy'));
});

test('error contract: unknown API route returns { error } JSON (SPA fallback excluded)', async () => {
  const res = await fetch(h.BASE_URL + '/api/definitely-not-found');
  assert.strictEqual(res.status, 404);
  assert.match(res.headers.get('content-type') || '', /application\/json/);
  const data = await res.json();
  assert.deepStrictEqual(Object.keys(data), ['error']);
  assert.strictEqual(data.error, 'API route not found');
});

test('login contract: success returns { token, user }', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'smoke@example.com', phone: '08166666666', password: 'secret123' });
  const r = await h.login('smoke@example.com', 'secret123');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.token);
  assert.ok(r.data.user);
  assert.strictEqual(typeof r.data.user.id, 'number');
  assert.strictEqual(typeof r.data.user.wallet, 'number');
  assert.strictEqual(typeof r.data.user.isAdmin, 'boolean');
});
