#!/usr/bin/env node
/**
 * TopFlowNG — Lightweight versioned SQL migration runner.
 *
 * Reads `migrations/*.sql` in lexical (version) order, tracks applied
 * migrations in `schema_migrations`, and applies each pending migration inside
 * a single transaction (PostgreSQL DDL is transactional), so a failure rolls
 * the whole migration back cleanly.
 *
 * Usage:
 *   npm run migrate            # apply pending migrations
 *   DATABASE_URL=... node migrations/migrate.js
 *
 * No new dependencies: uses the existing `pg` pool config.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { connectionSslOptions } = require('../lib/dbconn');

// Overridable so tests can point at a throwaway migration directory.
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.join(__dirname);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: connectionSslOptions(
    process.env.DATABASE_URL,
    process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  ),
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

function fail(message) {
  console.error(`[migrate] ERROR: ${message}`);
  process.exitCode = 1;
}

function loadMigrationFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fail(`migrations directory not found: ${MIGRATIONS_DIR}`);
    return null;
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function getApplied(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations');
  return new Set(rows.map((r) => r.version));
}

async function applyMigration(client, filename) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
  const version = filename.replace(/\.sql$/, '');
  const appliedAt = new Date();
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version, filename, applied_at) VALUES ($1, $2, $3)',
      [version, filename, appliedAt]
    );
    await client.query('COMMIT');
    console.log(`[migrate] applied ${filename}`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function run() {
  const files = loadMigrationFiles();
  if (!files) return;

  if (!process.env.DATABASE_URL) {
    fail('DATABASE_URL is not set');
    return;
  }

  const client = await pool.connect();
  try {
    await ensureMigrationsTable(client);
    const applied = await getApplied(client);

    let appliedCount = 0;
    for (const filename of files) {
      const version = filename.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`[migrate] skip ${filename} (already applied)`);
        continue;
      }
      await applyMigration(client, filename);
      appliedCount += 1;
    }

    if (appliedCount === 0) {
      console.log('[migrate] nothing to apply — schema is up to date');
    } else {
      console.log(`[migrate] ${appliedCount} migration(s) applied`);
    }
  } catch (err) {
    fail(`failed to apply migrations: ${err.message}`);
    if (process.env.MIGRATE_STACK !== undefined) console.error(err.stack);
  } finally {
    client.release();
    await pool.end();
  }
}

run();