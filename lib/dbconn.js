/**
 * TopFlowNG — Postgres connection-string helpers.
 *
 * Decides the `ssl` option for a `pg` Pool from the DATABASE_URL's `sslmode`
 * query parameter, falling back to the caller-provided default so existing
 * behaviour is preserved exactly when no explicit sslmode is present.
 *
 * Rationale: locking SSL to NODE_ENV==='production' makes it impossible to run
 * a production-grade config against a local/CI Postgres that has no TLS
 * (e.g. `sslmode=disable`, which is also what managed providers set when TLS is
 * terminated upstream). This lets operators opt out explicitly via the URL
 * without touching code.
 */

'use strict';

/**
 * @param {string} url  the DATABASE_URL (may be empty/undefined)
 * @param {*} fallback  the previous ssl value (boolean or options object)
 * @returns {*} an ssl option for `pg`
 */
function connectionSslOptions(url, fallback) {
  if (!url || typeof url !== 'string') return fallback;
  const qi = url.indexOf('?');
  if (qi === -1) return fallback;
  let params;
  try {
    params = new URLSearchParams(url.slice(qi + 1));
  } catch {
    return fallback;
  }
  const mode = (params.get('sslmode') || '').toLowerCase();
  if (!mode) return fallback;
  if (mode === 'disable' || mode === 'no') return false;
  if (mode === 'require' || mode === 'verify-ca' || mode === 'verify-full' || mode === 'prefer') {
    return { rejectUnauthorized: false };
  }
  return fallback;
}

module.exports = { connectionSslOptions };