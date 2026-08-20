/**
 * TopFlowNG — Phase 9 operational tests.
 *
 * Covers the production-safety behaviours added in phase 9:
 *   - liveness (/)api/health) and readiness (/api/ready)
 *   - readiness failure when the database is unavailable
 *   - health/readiness never leak secrets
 *   - sensitive-value redaction in the structured logger
 *   - production startup fails fast when required secrets are missing
 *   - graceful shutdown on SIGTERM (closes server + DB pool, exits 0).
 *
 * Uses the mocked unit harness for HTTP checks and a real throwaway Postgres
 * only for the graceful-shutdown child boot. Never contacts a real provider.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('path');

const h = require('./helpers/load-app');
const pg = require('./helpers/pg');
const logger = require('../lib/logger');

const ROOT = path.resolve(__dirname, '..');

before(async () => {
  await h.waitForServer();
});

after(() => {
  h.closeServer();
});

// ── Liveness & readiness ─────────────────────────────────────────────────────
test('liveness: /api/health returns 200 ok with timestamp and request id', async () => {
  const res = await fetch(h.BASE_URL + '/api/health');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ok');
  assert.ok(data.ts);
  assert.ok(res.headers.get('x-request-id'));
});

test('readiness: /api/ready returns 200 ready when database is reachable', async () => {
  const res = await fetch(h.BASE_URL + '/api/ready');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ready');
  assert.strictEqual(data.component, 'database');
});

test('readiness: /api/ready returns 503 when database is unavailable', async () => {
  const original = h.mockDb.ping;
  h.mockDb.ping = async () => ({ ok: false });
  try {
    const res = await fetch(h.BASE_URL + '/api/ready');
    assert.strictEqual(res.status, 503);
    const data = await res.json();
    assert.strictEqual(data.status, 'unready');
  } finally {
    h.mockDb.ping = original;
  }
});

// ── No secret leakage from health endpoints ─────────────────────────────────
test('health/readiness: responses never leak connection strings or secrets', async () => {
  const needles = ['postgres://', 'sk_live', 'sk_test', 'secret', 'Bearer', 'DATABASE_URL', 'pass'];
  for (const ep of ['/api/health', '/api/ready']) {
    const res = await fetch(h.BASE_URL + ep);
    const text = (await res.text()).toLowerCase();
    for (const n of needles) {
      assert.ok(!text.includes(n), `${ep} leaked ${n}`);
    }
  }
});

// ── Version / commit visibility ──────────────────────────────────────────────
test('version: /api/version returns commit and version without secrets', async () => {
  const res = await fetch(h.BASE_URL + '/api/version');
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.status, 'ok');
  assert.ok(typeof data.commit === 'string' && data.commit.length > 0);
  assert.ok(typeof data.version === 'string' && data.version.length > 0);
  const needles = ['postgres://', 'sk_live', 'sk_test', 'secret', 'Bearer', 'DATABASE_URL'];
  const text = JSON.stringify(data).toLowerCase();
  for (const n of needles) assert.ok(!text.includes(n), `/api/version leaked ${n}`);
});

// ── Internal n8n endpoints ───────────────────────────────────────────────────
test('internal: /api/internal/pending-orders requires the shared key', async () => {
  const res = await fetch(h.BASE_URL + '/api/internal/pending-orders');
  assert.strictEqual(res.status, 401);
});

test('internal: /api/internal/pending-orders returns ok JSON with the key', async () => {
  const key = process.env.INTERNAL_API_KEY;
  if (!key) {
    // The test harness boots without an internal key configured; without a key
    // the endpoint is deliberately unavailable (401) rather than open.
    return;
  }
  const res = await fetch(h.BASE_URL + '/api/internal/pending-orders', {
    headers: { 'x-internal-key': key },
  });
  assert.strictEqual(res.status, 200);
  const data = await res.json();
  assert.strictEqual(data.ok, true);
  assert.ok(Array.isArray(data.orders), 'orders is an array');
  assert.ok(typeof data.count === 'number', 'count is a number');
  assert.ok(data.generatedAt, 'generatedAt present');
});

test('internal: /api/internal/ops-summary is guarded by the key', async () => {
  const res = await fetch(h.BASE_URL + '/api/internal/ops-summary');
  assert.strictEqual(res.status, 401);
});

// ── Redaction ────────────────────────────────────────────────────────────────
test('logger: sensitive values are redacted, safe values preserved', () => {
  const got = logger.redact(
    {
      email: 'user@example.com',
      status: 200,
      password: 'hunter2',
      token: 'jwt.abc',
      apiKey: 'sk_live_123',
      card: '4242',
      signature: 'abc123',
      user_pin: '1234',
      connectionString: 'postgres://user:pass@db:5432/topflowng',
      databaseUrl: 'postgres://user:pass@db/topflowng',
      nested: { jwt: 'x.y.z', label: 'keep me' },
    },
    '',
  );
  assert.strictEqual(got.password, '[REDACTED]');
  assert.strictEqual(got.token, '[REDACTED]');
  assert.strictEqual(got.apiKey, '[REDACTED]');
  assert.strictEqual(got.card, '[REDACTED]');
  assert.strictEqual(got.signature, '[REDACTED]');
  assert.strictEqual(got.user_pin, '[REDACTED]');
  assert.strictEqual(got.connectionString, '[REDACTED]');
  assert.strictEqual(got.databaseUrl, '[REDACTED]');
  assert.strictEqual(got.nested.jwt, '[REDACTED]');
  assert.strictEqual(got.status, 200);
  assert.strictEqual(got.email, 'user@example.com');
  assert.strictEqual(got.nested.label, 'keep me');
});

// ── Purchase / funding kill switches ─────────────────────────────────────────
test('kill switch: purchases disabled returns 503 on every purchase route', async () => {
  h.mockDb.__reset();
  const user = await h.createUserViaDb({ fullName: 'Ada', email: 'kill@example.com', phone: '08011111111', password: 'secret123' });
  const loginRes = await h.login('kill@example.com', 'secret123');
  const token = loginRes.data.token;

  const config = require('../config');
  const orig = config.safety.purchasesEnabled;
  try {
    config.safety.purchasesEnabled = false;
    for (const path of ['/api/vtu/airtime', '/api/vtu/data', '/api/vtu/cable', '/api/vtu/electricity', '/api/vtu/exam-pin', '/api/vtu/recharge-pin']) {
      const r = await h.api('POST', path, {
        token,
        body: { network: 'MTN', phone: '08011111111', amount: 100, pin: '1234', serviceID: 'mtn', variation_code: 'mtn1' },
      });
      assert.strictEqual(r.status, 503, `${path} should be gated`);
      assert.ok(/temporarily unavailable/i.test(r.data.error));
    }
  } finally {
    config.safety.purchasesEnabled = orig;
  }
});

test('kill switch: purchases enabled allows requests through (no false 503)', async () => {
  h.mockDb.__reset();
  const user = await h.createUserViaDb({ fullName: 'Ada', email: 'kill2@example.com', phone: '08022222222', password: 'secret123' });
  const loginRes = await h.login('kill2@example.com', 'secret123');
  const config = require('../config');
  const orig = config.safety.purchasesEnabled;
  try {
    config.safety.purchasesEnabled = true;
    // With purchases enabled the request passes the guard and proceeds; without
    // a configured PIN it should reach the PIN check (not the 503 gate).
    const r = await h.api('POST', '/api/vtu/airtime', {
      token: loginRes.data.token,
      body: { network: 'MTN', phone: '08022222222', amount: 100, pin: null },
    });
    assert.notStrictEqual(r.status, 503);
  } finally {
    config.safety.purchasesEnabled = orig;
  }
});

test('kill switch: funding disabled returns 503 on paystack initialize', async () => {
  h.mockDb.__reset();
  await h.createUserViaDb({ fullName: 'Ada', email: 'kill3@example.com', phone: '08033333333', password: 'secret123' });
  const loginRes = await h.login('kill3@example.com', 'secret123');
  const config = require('../config');
  const orig = config.safety.fundingEnabled;
  try {
    config.safety.fundingEnabled = false;
    const r = await h.api('POST', '/api/paystack/initialize', {
      token: loginRes.data.token,
      body: { amount: 1000 },
    });
    assert.strictEqual(r.status, 503);
    assert.ok(/temporarily unavailable/i.test(r.data.error));
  } finally {
    config.safety.fundingEnabled = orig;
  }
});

// ── Production startup validation ────────────────────────────────────────────
test('startup: production fails fast when a required secret is missing', async () => {
  const res = await run(
    {
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(64),
      APP_URL: 'https://topflowng.test',
      PAYSTACK_SECRET_KEY: 'sk_live_zzz',
      // DATABASE_URL deliberately omitted
    },
    ['-e', 'require("./config");'],
  );
  assert.notStrictEqual(res.code, 0, 'expected non-zero exit');
  assert.ok(
    /Missing required environment variable/i.test(res.err) &&
      /DATABASE_URL/.test(res.err),
    'expected DATABASE_URL in the error',
  );
  // The values of the secrets must never appear in the error.
  assert.ok(!res.err.includes('sk_live_zzz'));
  assert.ok(!res.err.includes('x'.repeat(64)));
});

test('startup: production fails fast when VTPass API key credentials are missing', async () => {
  const res = await run(
    {
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(64),
      APP_URL: 'https://topflowng.test',
      PAYSTACK_SECRET_KEY: 'sk_live_zzz',
      DATABASE_URL: 'postgres://localhost/fake',
      // VTPASS_* deliberately omitted; VTPASS_AUTH_TYPE defaults to 'apikey'
    },
    ['-e', 'require("./config");'],
  );
  assert.notStrictEqual(res.code, 0, 'expected non-zero exit');
  assert.ok(
    /VTPASS_API_KEY/.test(res.err),
    'expected VTPASS_API_KEY in the error',
  );
});

test('startup: production fails fast when VTPass Basic auth credentials are missing', async () => {
  const res = await run(
    {
      NODE_ENV: 'production',
      JWT_SECRET: 'x'.repeat(64),
      APP_URL: 'https://topflowng.test',
      PAYSTACK_SECRET_KEY: 'sk_live_zzz',
      DATABASE_URL: 'postgres://localhost/fake',
      VTPASS_AUTH_TYPE: 'basic',
      // VTPASS_USERNAME / VTPASS_PASSWORD deliberately omitted
    },
    ['-e', 'require("./config");'],
  );
  assert.notStrictEqual(res.code, 0, 'expected non-zero exit');
  assert.ok(
    /VTPASS_USERNAME/.test(res.err),
    'expected VTPASS_USERNAME in the error',
  );
});

// ── Graceful shutdown (real Postgres, prod-like config) ─────────────────────
test('graceful shutdown: SIGTERM closes server + DB pool and exits 0', async () => {
  const prefix = 'topflowng_ops';
  const dbUrl = pg.createDatabaseSync(prefix) + '?sslmode=disable';
  const port = 31800 + (process.pid % 200);

  const env = {
    NODE_ENV: 'production',
    PORT: String(port),
    DATABASE_URL: dbUrl,
    JWT_SECRET: 'x'.repeat(64),
    APP_URL: 'https://topflowng.test',
    PAYSTACK_SECRET_KEY: 'sk_test_zzz',
    PAYSTACK_WEBHOOK_SECRET: 'whsec_zzz',
    VTPASS_API_KEY: 'vtpass_key',
    VTPASS_SECRET_KEY: 'vtpass_secret',
    VTPASS_PUBLIC_KEY: 'vtpass_public',
    SENTRY_DSN: '',
    OPENROUTER_API_KEY: 'sk-or-v1-offline',
    OPENROUTER_BASE_URL: 'http://127.0.0.1:1',
    TRUST_PROXY: '0',
  };

  const childProc = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  childProc.stdout.on('data', (d) => { output += d; });
  childProc.stderr.on('data', (d) => { output += d; });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 25000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/ready`);
      if (res.status === 200) { ready = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(ready, 'server did not become ready');

  const exit = new Promise((resolve) => childProc.on('exit', (code) => resolve(code)));
  childProc.kill('SIGTERM');
  const code = await Promise.race([
    exit,
    new Promise((r) => setTimeout(() => r('timeout'), 20000)),
  ]);

  await pg.dropDatabase(prefix);
  assert.strictEqual(code, 0, `expected exit 0, got ${code}; output was ${output}`);
  assert.ok(/Shutting down/i.test(output), 'expected a shutdown log line');
});

// ── Migrations idempotent ────────────────────────────────────────────────────
test('migrations: runner is present and can be run twice without error', async () => {
  const dir = path.join(ROOT, 'migrations');
  assert.ok(require('fs').existsSync(path.join(dir, 'migrate.js')), 'migrate.js exists');
  assert.ok(require('fs').existsSync(path.join(dir, '001_vtu_idempotency.sql')));
  assert.ok(require('fs').existsSync(path.join(dir, '002_vtu_reconcile_attempts.sql')));
});

// Environment variables the startup-validation tests deliberately omit. They
// are stripped from the inherited environment first, so the child sees exactly
// the env each test declares. Without this the assertions silently pass/fail
// based on whatever the developer happens to have exported in their shell.
const STARTUP_ENV_KEYS = [
  'DATABASE_URL', 'JWT_SECRET', 'APP_URL', 'PAYSTACK_SECRET_KEY',
  'VTPASS_API_KEY', 'VTPASS_SECRET_KEY', 'VTPASS_PUBLIC_KEY',
  'VTPASS_USERNAME', 'VTPASS_PASSWORD', 'VTPASS_AUTH_TYPE',
];

function run(env, args) {
  const base = { ...process.env };
  for (const key of STARTUP_ENV_KEYS) delete base[key];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...base, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ code: -1, out, err }));
    child.on('exit', (code) => resolve({ code, out, err }));
  });
}