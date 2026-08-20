/**
 * TopFlowNG — Playwright global teardown.
 *
 * The browser harness boots against a dedicated throwaway PostgreSQL database
 * (`topflowng_ui_<pid>`). Playwright hard-kills its webServer at the end, which
 * prevents the harness's own async cleanup from completing, so this step — run
 * in the MAIN process after all tests have finished — deterministically drops
 * any leftover throwaway databases. The shared `topflowng_test` (and any real
 * `topflowng`/production DB) is never touched.
 */

'use strict';

const { Pool } = require('pg');

const PG_HOST = process.env.PG_HOST || '127.0.0.1';
const { resolvePgPort } = require('../helpers/pg.js');
const PG_PORT = resolvePgPort();
const PG_USER = process.env.PG_USER || 'postgres';
const PG_PASSWORD = process.env.PG_PASSWORD || '';
const PG_ADMIN_DB = process.env.PG_ADMIN_DB || 'postgres';

const auth = PG_PASSWORD
  ? `${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASSWORD)}@`
  : `${encodeURIComponent(PG_USER)}@`;

module.exports = async function globalTeardown() {
  const pool = new Pool({ connectionString: `postgres://${auth}${PG_HOST}:${PG_PORT}/${PG_ADMIN_DB}`, max: 2 });
  try {
    const { rows } = await pool.query(
      `SELECT datname FROM pg_database WHERE datname LIKE 'topflowng\\_%' ORDER BY datname`,
    );
    for (const { datname } of rows) {
      if (datname === 'topflowng_test') continue;
      await pool.query(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`);
    }
  } finally {
    await pool.end().catch(() => {});
  }
};