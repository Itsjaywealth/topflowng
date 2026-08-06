# TopFlowNG — Operations Guide

Operational reference for running TopFlowNG in production: environment
variables, configuration checklist, run/monitor, backups, scaling, post-deploy
smoke test. Incident runbooks live in **RUNBOOK.md**; security posture is
audited in **SECURITY-CHECKLIST.md**.

---

## 1. Environment variable reference

**REQUIRED — production fails fast at startup if missing** (`config.js` reports
only the variable *names*, never values). These are **mandatory for every
production deployment** — wallet top-up (Paystack) and VTU (Clubkonnect) are the
platform's only money flows and there is **no** supported payments/VTU-disabled
mode. There is deliberately no opt-out flag; pausing payments is expressed
operationally (stop routing traffic), never by booting without the keys.
Authenticity is validated by each provider on the first live call; boot-time
validation only guarantees a value was supplied:

| Variable | Purpose |
|----------|---------|
| `NODE_ENV` | `production` |
| `DATABASE_URL` | Postgres connection string (see `?sslmode` in DEPLOYMENT.md) |
| `JWT_SECRET` | JWT signing secret (≥64 random chars) |
| `APP_URL` | Canonical origin — CORS allow-list, callbacks, reset links |
| `PAYSTACK_SECRET_KEY` | Paystack payments (`sk_live_…`) |
| `CLUBKONNECT_USER_ID` | VTU provider account |
| `CLUBKONNECT_API_KEY` | VTU provider key |

**OPTIONAL — feature degraded / disabled when absent:**

| Variable | Effect when absent |
|----------|--------------------|
| `PAYSTACK_WEBHOOK_SECRET` | Webhooks verified with `PAYSTACK_SECRET_KEY` instead |
| `RESEND_API_KEY` | Password reset / purchase emails fail to send |
| `OPENROUTER_API_KEY` | AI assistant disabled/errors |
| `SENTRY_DSN` | Sentry fully disabled (no init, no traffic) |

**Tuning (all optional):** `PORT` (default 3000), `TRUST_PROXY` (default 1),
`BODY_LIMIT` (10kb), `JWT_EXPIRES_IN` (7d), `AUTH_RATE_WINDOW_MS`,
`AUTH_RATE_MAX`, `API_RATE_WINDOW_MS`, `API_RATE_MAX`, `LOG_LEVEL`
(debug|info|warn|error), `SENTRY_TRACES_SAMPLE_RATE`, `CLUBKONNECT_*` endpoints
and `CLUBKONNECT_TIMEOUT_MS`, `MAX_PURCHASE_AMOUNT`, `RESEND_FROM`,
`RESEND_URL`, `RESEND_TIMEOUT_MS`, `PAYSTACK_API_BASE_URL`,
`PAYSTACK_TIMEOUT_MS`, `OPENROUTER_*` family, `AI_*` family.

**Test-only (never set in production):** `PG_HOST`, `PG_PORT`, `PG_USER`,
`PG_PASSWORD`, `PG_ADMIN_DB`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD`. These are
used only by the automated test suite. `.env.example` documents all variables
with non-secret placeholders.

---

## 2. Production configuration checklist

- [ ] `NODE_ENV=production` and all REQUIRED vars set (DATABASE_URL, JWT_SECRET,
      APP_URL, PAYSTACK_SECRET_KEY, CLUBKONNECT_USER_ID, CLUBKONNECT_API_KEY).
- [ ] `JWT_SECRET` is a fresh random ≥64 char value, never the default.
- [ ] `APP_URL` matches the real public origin (HTTPS).
- [ ] `DATABASE_URL` points at the production Postgres with proper `sslmode`.
- [ ] `TRUST_PROXY=1` IF behind a TLS-terminating proxy (default); else `0`.
- [ ] Secrets are in the host's config system, **not** in the repo or `.env`.
- [ ] `SENTRY_DSN` set and the Sentry project configured for `production` env.
- [ ] Rate limits tuned for expected traffic (defaults are conservative).
- [ ] Reverse proxy/load balancer health-check path → `/api/ready`.
- [ ] Backup schedule enabled (see §Backups).

---

## 3. Run & log

- **Start:** `node server.js` (or `web: node server.js` via Procfile / Docker).
- **Logs:** one JSON object per line to stdout (info/debug) or stderr
  (warn/error). Fields: `level`, `timestamp`, `msg`, and for each HTTP request:.
  `requestId`, `method`, `route`, `status`, `durationMs`. Every response header
  includes `X-Request-Id` — correlate logs and client reports with it.
- **Redaction:** the logger recursively redacts sensitive keys (`password`,
  `token`, `secret`, `api_key`, `card`, `pin`, `JWT`, `signature`, …). Never log
  request bodies or full provider responses; caller handlers already log only
  safe fields.
- **Sentry:** initialised only when `SENTRY_DSN` is set. Captures exceptions on
  the major routes.

---

## 4. Alerts

Wire alerts (log-based, Sentry, or infra) for the conditions in **RUNBOOK.md →
Alert matrix**, at minimum:

- rate of HTTP `5xx` responses (e.g. >threshold per minute)
- failed Paystack webhook signature verifications (`Invalid Paystack webhook
  signature`)
- pending-order reconciliation failures
- repeated CLUBKONNECT/provider failures
- database connection failures (/api/ready returns 503, connection pool errors)
- AI provider (`OpenRouter`) failures and `AI_DAILY_COST_CEILING` breaches
- auth rate-limit spikes (lockouts)

---

## 5. Backups (PostgreSQL) & verification

**Backup (pg_dump), daily + before destructive ops:**

```bash
pg_dump --no-owner --no-privileges \
  "$DATABASE_URL" | gzip > topflowng-$(date +%F).sql.gz
```

**Restore (into a fresh DB):**

```bash
gunzip -c topflowng-2026-08-06.sql.gz | psql "$NEW_DATABASE_URL"
```

**Verification procedure (do after every backup, at least weekly):**

1. Create a throwaway Postgres database.
2. Restore the latest backup into it.
3. `SELECT COUNT(*) FROM users;` and re-run the digests of core tables; confirm
   counts > 0 and match expectations.
4. Run `npm run migrate` against the restored DB (must report up to date).
5. Boot the app pointed temporarily at the restored DB; confirm `/api/ready`
   returns 200 and a real login can be executed.
6. Drop the throwaway restore DB.

Store backups in a different location/region from the live database.

---

## 6. Resources & scaling assumptions

- **Stateless app:** any number of app instances can run; stickiness is not
  required. Scale horizontally behind the host's load balancer.
- **Rate limiter storage:** in-memory by default (`express-rate-limit`). With
  multiple instances the counts are per-instance. For strict global limits,
  either pin traffic to one instance or run a shared backing store. This is an
  accepted assumption at current scale; revisit if the app is multi-region.
- **Database:** the single source of truth; test pool `max: 10`. Choose a
  managed Postgres tier sized to connected instances ×10 connections + margin.
- **In-memory token revocation/lockout** (`services/security.js`) is per-process;
  with multiple instances, prefer short TTLs and JWT expiry so a revoke
  propagates quickly. No replication or sharding is implemented (out of scope).