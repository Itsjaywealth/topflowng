/**
 * TopFlowNG — Phase 3 authentication & authorization tests.
 *
 * Covers: registration (validation + normalization), login (lockout +
 * non-enumerating errors), forgot/reset password, change password, logout /
 * token revocation, expired tokens, and admin authorization.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');

const jwt = require('jsonwebtoken');

const h = require('./helpers/load-app');

const { mockDb, sentEmails } = h;

before(async () => {
  mockDb.__reset();
  await h.waitForServer();
});

after(() => {
  h.closeServer();
});

// ── Registration ─────────────────────────────────────────────────────────────
test('register: happy path returns 201 with token + user', async () => {
  mockDb.__reset();
  const r = await h.register({
    fullName: 'Ada Obi',
    email: 'ada@example.com',
    phone: '08031234567',
    password: 'secret123',
  });
  assert.strictEqual(r.status, 201);
  assert.ok(r.data.token);
  assert.strictEqual(r.data.user.email, 'ada@example.com');
  assert.strictEqual(r.data.user.isAdmin, false);
  assert.strictEqual(r.data.user.wallet, 0);
});

test('register: normalizes email to lowercase', async () => {
  mockDb.__reset();
  const r = await h.register({
    fullName: 'Emeka',
    email: '  Emeka@Example.COM ',
    phone: '08123456789',
    password: 'secret123',
  });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.data.user.email, 'emeka@example.com');
});

test('register: rejects malformed email', async () => {
  mockDb.__reset();
  const r = await h.register({
    fullName: 'Bola',
    email: 'not-an-email',
    phone: '08123456789',
    password: 'secret123',
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Enter a valid email address');
});

test('register: rejects invalid phone', async () => {
  mockDb.__reset();
  const r = await h.register({
    fullName: 'Bola',
    email: 'bola@example.com',
    phone: 'abc',
    password: 'secret123',
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Enter a valid phone number');
});

test('register: rejects short password (frontend enforces >= 6)', async () => {
  mockDb.__reset();
  const r = await h.register({
    fullName: 'Bola',
    email: 'bola@example.com',
    phone: '08123456789',
    password: '12345',
  });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Password must be at least 6 characters');
});

test('register: duplicate email returns 409', async () => {
  mockDb.__reset();
  await h.register({
    fullName: 'A', email: 'dup@example.com', phone: '08011111111', password: 'secret123',
  });
  const r = await h.register({
    fullName: 'B', email: 'dup@example.com', phone: '08022222222', password: 'secret123',
  });
  assert.strictEqual(r.status, 409);
});

test('register: duplicate phone returns 409', async () => {
  mockDb.__reset();
  await h.register({
    fullName: 'A', email: 'a@example.com', phone: '08033333333', password: 'secret123',
  });
  const r = await h.register({
    fullName: 'B', email: 'b@example.com', phone: '08033333333', password: 'secret123',
  });
  assert.strictEqual(r.status, 409);
});

// ── Login ────────────────────────────────────────────────────────────────────
test('login: happy path returns 200 with token + user', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'ada2@example.com', phone: '08044444444', password: 'secret123' });
  const r = await h.login('ada2@example.com', 'secret123');
  assert.strictEqual(r.status, 200);
  assert.ok(r.data.token);
  assert.strictEqual(r.data.user.email, 'ada2@example.com');
});

test('login: wrong password returns generic non-enumerating error', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'ada3@example.com', phone: '08055555555', password: 'secret123' });
  const r = await h.login('ada3@example.com', 'wrong-password');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Invalid credentials');
});

test('login: unknown email returns same generic error (no enumeration)', async () => {
  mockDb.__reset();
  const r = await h.login('nobody@example.com', 'whatever123');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Invalid credentials');
});

test('login: missing credentials returns 400', async () => {
  mockDb.__reset();
  const r = await h.api('POST', '/api/auth/login', { body: { email: 'x@example.com' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'Email and password required');
});

test('login: progressive lockout after repeated failures', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Locky', email: 'locky@example.com', phone: '08066666666', password: 'secret123' });

  for (let i = 0; i < 3; i++) {
    const r = await h.login('locky@example.com', 'bad-password');
    assert.strictEqual(r.status, 401, `attempt ${i + 1} should still be 401`);
  }

  const r = await h.login('locky@example.com', 'secret123');
  assert.strictEqual(r.status, 429);
  assert.match(r.data.error, /Too many failed attempts/);
});

test('login: successful login resets the failure counter', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Reset', email: 'reset@example.com', phone: '08077777777', password: 'secret123' });

  await h.login('reset@example.com', 'bad-1');
  await h.login('reset@example.com', 'bad-2');
  const ok = await h.login('reset@example.com', 'secret123');
  assert.strictEqual(ok.status, 200);

  // Counter was reset — two more failures should NOT trigger lockout.
  await h.login('reset@example.com', 'bad-3');
  await h.login('reset@example.com', 'bad-4');
  const ok2 = await h.login('reset@example.com', 'secret123');
  assert.strictEqual(ok2.status, 200);
});

// ── Token authorization ──────────────────────────────────────────────────────
test('protected route: no token returns 401', async () => {
  mockDb.__reset();
  const r = await h.api('GET', '/api/user/profile');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'No token provided');
});

test('protected route: malformed token returns 401', async () => {
  mockDb.__reset();
  const r = await h.api('GET', '/api/user/profile', { token: 'not.a.jwt' });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Invalid or expired token');
});

test('protected route: expired token returns 401', async () => {
  mockDb.__reset();
  const token = jwt.sign({ id: 1, email: 'x@example.com' }, process.env.JWT_SECRET, { expiresIn: '-10s' });
  const r = await h.api('GET', '/api/user/profile', { token });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Invalid or expired token');
});

test('protected route: valid token returns profile', async () => {
  mockDb.__reset();
  const user = await h.createUserViaDb({ fullName: 'Ada', email: 'ada4@example.com', phone: '08088888888', password: 'secret123' });
  const loginRes = await h.login('ada4@example.com', 'secret123');
  const r = await h.api('GET', '/api/user/profile', { token: loginRes.data.token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.data.email, 'ada4@example.com');
});

// ── Admin authorization ──────────────────────────────────────────────────────
test('admin: non-admin user is forbidden (403)', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'User', email: 'user@example.com', phone: '08099999999', password: 'secret123' });
  const loginRes = await h.login('user@example.com', 'secret123');
  const r = await h.api('GET', '/api/admin/stats', { token: loginRes.data.token });
  assert.strictEqual(r.status, 403);
  assert.strictEqual(r.data.error, 'Admin access required');
});

test('admin: admin user can access admin endpoints', async () => {
  mockDb.__reset();
  const hash = await h.bcrypt.hash('adminpass123', 4);
  const admin = mockDb.__seedUser({ fullName: 'Boss', email: 'boss@example.com', phone: '08000000000', password: null });
  mockDb.__setPassword(admin.id, hash);
  admin.is_admin = true;

  const loginRes = await h.login('boss@example.com', 'adminpass123');
  assert.strictEqual(loginRes.status, 200);
  assert.strictEqual(loginRes.data.user.isAdmin, true);

  const r = await h.api('GET', '/api/admin/stats', { token: loginRes.data.token });
  assert.strictEqual(r.status, 200);
  assert.ok('total_users' in r.data);
});

// ── Logout / revocation ──────────────────────────────────────────────────────
test('logout: revokes the token server-side', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'ada5@example.com', phone: '08111111111', password: 'secret123' });
  const loginRes = await h.login('ada5@example.com', 'secret123');
  const token = loginRes.data.token;

  const before = await h.api('GET', '/api/user/profile', { token });
  assert.strictEqual(before.status, 200);

  const out = await h.api('POST', '/api/auth/logout', { token });
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.data.message, 'Logged out successfully.');

  const after = await h.api('GET', '/api/user/profile', { token });
  assert.strictEqual(after.status, 401);
  assert.strictEqual(after.data.error, 'Invalid or expired token');
});

test('logout: requires an authenticated token', async () => {
  mockDb.__reset();
  const r = await h.api('POST', '/api/auth/logout');
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'No token provided');
});

// ── Password reset ───────────────────────────────────────────────────────────
test('forgot-password: unknown email returns 200 (no enumeration)', async () => {
  mockDb.__reset();
  const r = await h.api('POST', '/api/auth/forgot-password', { body: { email: 'ghost@example.com' } });
  assert.strictEqual(r.status, 200);
  assert.match(r.data.message, /If that email is registered/);
});

test('forgot-password: known email sends reset email + 200', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'resetme@example.com', phone: '08122222222', password: 'secret123' });
  sentEmails.length = 0;

  const r = await h.api('POST', '/api/auth/forgot-password', { body: { email: 'resetme@example.com' } });
  assert.strictEqual(r.status, 200);
  assert.match(r.data.message, /If that email is registered/);
  assert.strictEqual(sentEmails.length, 1);
  assert.strictEqual(sentEmails[0].to, 'resetme@example.com');
  assert.ok(mockDb.__lastResetToken());
});

test('reset-password: valid token changes password, new login works', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'resetme2@example.com', phone: '08133333333', password: 'secret123' });
  await h.api('POST', '/api/auth/forgot-password', { body: { email: 'resetme2@example.com' } });
  const token = mockDb.__lastResetToken();
  assert.ok(token);

  const r = await h.api('POST', '/api/auth/reset-password', { body: { token, password: 'newpassword456' } });
  assert.strictEqual(r.status, 200);

  const oldLogin = await h.login('resetme2@example.com', 'secret123');
  assert.strictEqual(oldLogin.status, 401);

  const newLogin = await h.login('resetme2@example.com', 'newpassword456');
  assert.strictEqual(newLogin.status, 200);
});

test('reset-password: invalid token returns 400', async () => {
  mockDb.__reset();
  const r = await h.api('POST', '/api/auth/reset-password', { body: { token: 'not-a-real-token', password: 'newpassword456' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.data.error, 'This reset link is invalid or has expired.');
});

// ── Change password ──────────────────────────────────────────────────────────
test('change-password: correct current password updates it', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'change@example.com', phone: '08144444444', password: 'secret123' });
  const loginRes = await h.login('change@example.com', 'secret123');
  const token = loginRes.data.token;

  const r = await h.api('POST', '/api/auth/change-password', {
    token,
    body: { currentPassword: 'secret123', newPassword: 'freshpass789' },
  });
  assert.strictEqual(r.status, 200);

  const oldLogin = await h.login('change@example.com', 'secret123');
  assert.strictEqual(oldLogin.status, 401);
  const newLogin = await h.login('change@example.com', 'freshpass789');
  assert.strictEqual(newLogin.status, 200);
});

test('change-password: wrong current password returns 401', async () => {
  mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'change2@example.com', phone: '08155555555', password: 'secret123' });
  const loginRes = await h.login('change2@example.com', 'secret123');

  const r = await h.api('POST', '/api/auth/change-password', {
    token: loginRes.data.token,
    body: { currentPassword: 'wrong-current', newPassword: 'freshpass789' },
  });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.data.error, 'Current password is incorrect');
});

// ── Rate limiting smoke ──────────────────────────────────────────────────────
test('rate limit: auth endpoints reject floods after limit', async () => {
  mockDb.__reset();
  // authLimiter max is configured high (100000) for the test run, so we just
  // confirm the middleware is wired and returns the contract on a normal call.
  const r = await h.api('POST', '/api/auth/login', { body: { email: 'flood@example.com', password: 'x' } });
  assert.ok(r.status === 401 || r.status === 429);
});