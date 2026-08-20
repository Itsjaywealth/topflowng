/**
 * TopFlowNG — throwaway-PostgreSQL test helper.
 *
 * Portably creates and drops a UNIQUE throwaway database for a test process,
 * using only the `pg` package (no `psql` binary, no hardcoded path). Every
 * caller passes a name prefix and this helper fingerprints the database name
 * with `process.pid` so parallel `node --test` files never collide and never
 * touch a shared `topflowng_test` (or production) database.
 *
 * Connection basics are read from the environment (safe CI defaults):
 *   PG_HOST       (default 127.0.0.1)
 *   PG_PORT       (auto-detected: probes 55432 then 5432 unless set explicitly)
 *   PG_USER       (default postgres)
 *   PG_PASSWORD   (default '' — works with postgres `trust` auth)
 *   PG_ADMIN_DB   (default postgres — control DB used to create/drop)
 */

'use strict';

const { Pool } = require('pg');
const { execFileSync } = require('node:child_process');

const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const PG_PORT = resolvePgPort();
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_ADMIN_DB = process.env.PG_ADMIN_DB || 'postgres';

/**
 * Resolve the Postgres port to use for tests.
 *
 * An explicit PG_PORT wins outright. Otherwise we probe candidates in order —
 * the documented throwaway-cluster port (55432) first, then the standard local
 * default (5432) — and pick the first one a Postgres server is actually
 * listening on. This lets `npm test` "just work" against a standard Homebrew /
 * distro install while still honouring a dedicated test cluster on 55432.
 *
 * The probe is fully synchronous (via a child node process) so it can run at
 * module load, where this helper is required before the server boots.
 */
function resolvePgPort() {
  if (process.env.PG_PORT) return Number(process.env.PG_PORT);
  const { execFileSync } = require('node:child_process');
  const script = `const {connect}=require('net');const s=connect({host:process.env.H,port:+process.env.P});s.once('connect',()=>process.exit(0));s.once('error',()=>process.exit(1));setTimeout(()=>process.exit(1),300);`;
  for (const port of [55432, 5432]) {
    try {
      execFileSync(process.execPath, ['-e', script], {
        encoding: 'utf8',
        stdio: 'ignore',
        env: { ...process.env, H: PG_HOST, P: String(port) },
      });
      return port;
    } catch {
      /* try next */
    }
  }
  return 55432;
}

/** Build a libpq connection string to a specific database. */
function dbUrl(name) {
  const auth = PG_PASSWORD
    ? `${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASSWORD)}@`
    : `${encodeURIComponent(PG_USER)}@`;
  return `postgres://${auth}${PG_HOST}:${PG_PORT}/${name}`;
}

/** Connection string to the control (admin) database. */
function adminDbUrl() {
  return dbUrl(PG_ADMIN_DB);
}

/** Build the per-process throwaway database name for a prefix. */
function databaseName(prefix) {
  return `${prefix}_${process.pid}`;
}

/**
 * Create a named database (dropping any stale one first). Used directly by the
 * async path and by the synchronised child process, so the created name always
 * matches the caller's `process.pid` exactly.
 */
async function createNamedDatabase(name) {
  const admin = new Pool({ connectionString: adminDbUrl(), max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`);
    await admin.query(`CREATE DATABASE ${quoteIdent(name)}`);
  } finally {
    await admin.end();
  }
}

/**
 * Create a fresh throwaway database and return its connection string. Drops any
 * stale database of the same name first so re-runs are idempotent.
 */
async function createDatabase(prefix) {
  const name = databaseName(prefix);
  await createNamedDatabase(name);
  return dbUrl(name);
}

/**
 * Drop a previously created throwaway database. Safeguards: only ever drops
 * databases whose name begins with the given prefix; tolerates still-open
 * connections (WITH (FORCE)) and already-deleted state.
 */
async function dropDatabase(prefix) {
  const name = databaseName(prefix);
  if (!name.startsWith('topflowng_')) return;
  if (!name.startsWith(`${prefix}_`)) return;
  const admin = new Pool({ connectionString: adminDbUrl(), max: 2 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)} WITH (FORCE)`);
  } catch {
    try { await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(name)}`); } catch { /* already gone */ }
  } finally {
    await admin.end();
  }
}

/**
 * Synchronous, never-throws drop of this process's throwaway DB. Spawns a
 * child node process that performs the DROP (WITH (FORCE)) and blocks until it
 * finishes. Used from a `process.on('exit')` hook so the throwaway database is
 * removed even if the ambient async shutdown is interrupted by a kill.
 */
function dropDatabaseSync(prefix) {
  const name = databaseName(prefix);
  if (!name.startsWith('topflowng_')) return;
  if (!name.startsWith(`${prefix}_`)) return;
  const ident = quoteIdent(name);
  const script = `
    const { Pool } = require('pg');
    const p = new Pool({ connectionString: ${JSON.stringify(adminDbUrl())}, max: 1 });
    p.query('DROP DATABASE IF EXISTS ${ident} WITH (FORCE)')
      .finally(() => p.end())
      .then(() => process.exit(0))
      .catch(() => process.exit(0));
  `;
  try { execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }); } catch { /* best effort */ }
}

/**
 * Synchronous variant used by harnesses that must create the throwaway DB
 * before they require() the (sync) server module. Spawns a child node process
 * that creates the SAME named database this process will drop, then blocks
 * until the child finishes. Returns the connection string. No psql binary
 * required.
 */
function createDatabaseSync(prefix) {
  const name = databaseName(prefix);
  const script = `
    const { createNamedDatabase } = require(${JSON.stringify(__filename)});
    createNamedDatabase(${JSON.stringify(name)})
      .then(() => process.exit(0))
      .catch((e) => { console.error('PG_CREATE_FAILED:' + e.message); process.exit(1); });
  `;
  execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  return dbUrl(name);
}

function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

module.exports = {
  PG_HOST,
  PG_PORT,
  PG_USER,
  PG_PASSWORD,
  PG_ADMIN_DB,
  resolvePgPort,
  dbUrl,
  adminDbUrl,
  databaseName,
  createDatabase,
  createNamedDatabase,
  createDatabaseSync,
  dropDatabase,
  dropDatabaseSync,
};