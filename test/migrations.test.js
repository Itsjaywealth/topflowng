/**
 * TopFlowNG — Migration runner + VTU idempotency schema tests (Phase 4C).
 *
 * Runs against a DEDICATED throwaway PostgreSQL database (created and dropped
 * here), never against `topflowng_test` or any production database. It:
 *   - bootstraps the base schema (users + vtu_orders only, matching the live
 *     app's table shapes)
 *   - applies migration 001 via the runner
 *   - asserts idempotent rerun, legacy (NULL key) rows, per-user key
 *     uniqueness, cross-user key reuse, index presence, and clean rollback of
 *     a deliberately failing migration.
 */

'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = Number(process.env.PG_PORT || 55432);
const PG_USER = process.env.PG_USER || 'postgres';
const ADMIN_DB = 'postgres';

const DB_NAME = `topflowng_mig_${process.pid}`;
const TEST_DB_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${DB_NAME}`;
const ADMIN_URL = `postgres://${PG_USER}@${PG_HOST}:${PG_PORT}/${ADMIN_DB}`;

const REPO_ROOT = path.resolve(__dirname, '..');
const MIGRATE_JS = path.join(REPO_ROOT, 'migrations', 'migrate.js');

let pool = null;

// Base schema (subset of database.js initDB) required by migration 001.
const BASE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    full_name   TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    phone       TEXT UNIQUE NOT NULL,
    password    TEXT NOT NULL,
    wallet      NUMERIC(12,2) NOT NULL DEFAULT 0,
    is_admin    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS vtu_orders (
    id                    BIGSERIAL PRIMARY KEY,
    request_id            TEXT UNIQUE NOT NULL,
    user_id               INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    service_type          TEXT NOT NULL,
    amount                NUMERIC(12,2) NOT NULL,
    description           TEXT NOT NULL,
    provider_order_id     TEXT,
    status                TEXT NOT NULL DEFAULT 'submitted'
                          CHECK (status IN ('submitted', 'pending', 'completed', 'failed')),
    transaction_id        INTEGER,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

function runMigrate(env) {
  return execFileSync('node', [MIGRATE_JS], {
    env: { ...process.env, DATABASE_URL: TEST_DB_URL, ...env },
    encoding: 'utf8',
  });
}

async function q(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function getIndexes(table) {
  const { rows } = await pool.query(
    `SELECT indexname FROM pg_indexes WHERE tablename = $1`,
    [table]
  );
  return new Set(rows.map((r) => r.indexname));
}

async function insertUser(fullName, email, phone) {
  const { rows } = await pool.query(
    `INSERT INTO users (full_name, email, phone, password) VALUES ($1, $2, $3, 'x') RETURNING id`,
    [fullName, email, phone]
  );
  return rows[0].id;
}

async function insertVtuOrder(userId, requestId, extra = {}) {
  const cols = ['user_id', 'request_id', 'service_type', 'amount', 'description'];
  const vals = [userId, requestId, 'airtime', 100, 'test'];
  const set = [];
  Object.entries(extra).forEach(([k, v]) => {
    set.push(k);
    vals.push(v);
  });
  const placeholders = vals.map((_, i) => `$${i + 1}`);
  const colList = cols.concat(set).join(', ');
  const { rows } = await pool.query(
    `INSERT INTO vtu_orders (${colList}) VALUES (${placeholders.join(', ')}) RETURNING id`,
    vals
  );
  return rows[0].id;
}

before(async () => {
  // Create a fresh throwaway DB and bootstrap base schema.
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();

  pool = new Pool({ connectionString: TEST_DB_URL, max: 5 });
  await pool.query(BASE_SCHEMA);
});

after(async () => {
  if (pool) {
    await pool.end().catch(() => {});
    pool = null;
  }
  const admin = new Pool({ connectionString: ADMIN_URL, max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
  } catch {
    // Some PG versions may not support WITH (FORCE); retry plain drop.
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`).catch(() => {});
  }
  await admin.end();
});

test('migration 001 applies successfully', async () => {
  const out = runMigrate();
  assert.match(out, /applied 001_vtu_idempotency\.sql/);
  assert.match(out, /applied 002_vtu_reconcile_attempts\.sql/);

  const rows = await q('SELECT version FROM schema_migrations ORDER BY version');
  assert.deepStrictEqual(rows.map((r) => r.version), ['001_vtu_idempotency', '002_vtu_reconcile_attempts']);

  const cols = await q(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'vtu_orders' AND column_name IN
       ('idempotency_key','request_fingerprint','response_snapshot',
        'idempotency_key_created_at','idempotency_key_last_used_at')`
  );
  assert.strictEqual(cols.length, 5, 'all idempotency columns must exist');
});

test('migration 002 adds reconciliation attempt tracking columns', async () => {
  const rows = await q(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_name = 'vtu_orders' AND column_name IN
       ('reconcile_attempts', 'last_reconciled_at')
     ORDER BY column_name`
  );
  const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]));
  assert.ok(byName.reconcile_attempts, 'reconcile_attempts column exists');
  assert.strictEqual(byName.reconcile_attempts.data_type, 'integer');
  assert.strictEqual(byName.reconcile_attempts.is_nullable, 'NO');
  assert.strictEqual(byName.reconcile_attempts.column_default, '0', 'defaults to 0');
  assert.ok(byName.last_reconciled_at, 'last_reconciled_at column exists');
  assert.strictEqual(byName.last_reconciled_at.data_type, 'timestamp with time zone');
});

test('re-running migrations is a no-op', async () => {
  const beforeCount = (await q('SELECT COUNT(*)::int AS c FROM schema_migrations'))[0].c;
  const out = runMigrate();
  assert.match(out, /nothing to apply/);
  const afterCount = (await q('SELECT COUNT(*)::int AS c FROM schema_migrations'))[0].c;
  assert.strictEqual(afterCount, beforeCount, 'no new rows on rerun');
});

test('existing schema/data remains valid (legacy NULL keys allowed)', async () => {
  const u = await insertUser('Legacy', 'legacy@example.com', '08000000001');
  const a = await insertVtuOrder(u, 'LEGACY-1');
  const b = await insertVtuOrder(u, 'LEGACY-2'); // multiple NULL-key rows OK
  assert.ok(a > 0 && b > 0);

  const row = (await q('SELECT idempotency_key, request_fingerprint, response_snapshot FROM vtu_orders WHERE id = $1', [a]))[0];
  assert.strictEqual(row.idempotency_key, null);
  assert.strictEqual(row.request_fingerprint, null);
  assert.strictEqual(row.response_snapshot, null);
});

test('same user cannot reuse the same non-null idempotency key', async () => {
  const u = await insertUser('Same', 'same@example.com', '08000000002');
  await insertVtuOrder(u, 'SAME-1', { idempotency_key: 'KEY-1', request_fingerprint: 'fp-1' });
  await assert.rejects(
    insertVtuOrder(u, 'SAME-2', { idempotency_key: 'KEY-1', request_fingerprint: 'fp-2' }),
    /duplicate key value violates unique constraint "idx_vtu_orders_idempotency_scope"/
  );
});

test('different users can use the same idempotency key', async () => {
  const u1 = await insertUser('U1', 'u1@example.com', '08000000003');
  const u2 = await insertUser('U2', 'u2@example.com', '08000000004');
  await insertVtuOrder(u1, 'CROSS-1', { idempotency_key: 'SHARED-KEY', request_fingerprint: 'fp' });
  const ok = await insertVtuOrder(u2, 'CROSS-2', { idempotency_key: 'SHARED-KEY', request_fingerprint: 'fp' });
  assert.ok(ok > 0);
});

test('expected indexes exist', async () => {
  const idx = await getIndexes('vtu_orders');
  // Indexes created by migration 001.
  for (const name of [
    'idx_vtu_orders_idempotency_scope',
    'idx_vtu_orders_user_status',
  ]) {
    assert.ok(idx.has(name), `missing index ${name}`);
  }
});

test('failed migration rolls back cleanly', async () => {
  // Create a temp migrations dir with a good migration and a failing one.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-mig-'));
  fs.writeFileSync(
    path.join(tmpDir, '001_ok.sql'),
    'CREATE TABLE rollback_marker (id SERIAL PRIMARY KEY);'
  );
  fs.writeFileSync(
    path.join(tmpDir, '002_bad.sql'),
    'CREATE TABLE rollback_partial (id SERIAL PRIMARY KEY);\nSELECT * FROM does_not_exist;'
  );

  assert.throws(() => {
    runMigrate({ MIGRATIONS_DIR: tmpDir });
  }, /failed to apply migrations/);

  // The failing migration must not be recorded as applied.
  const rows = await q(
    `SELECT version FROM schema_migrations WHERE version = '002_bad'`
  );
  assert.strictEqual(rows.length, 0, 'failing migration must not be recorded');

  // Its partial work (the table created before the failure) must be rolled back.
  const partial = await q(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'rollback_partial'`
  );
  assert.strictEqual(partial.length, 0, 'partial table must be rolled back');

  // The earlier good migration in the same run committed atomically.
  const marker = await q(
    `SELECT 1 FROM information_schema.tables
     WHERE table_schema = 'public' AND table_name = 'rollback_marker'`
  );
  assert.strictEqual(marker.length, 1, 'previous good migration committed');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});