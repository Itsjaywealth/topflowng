# TopFlowNG — Deployment Guide

Canonical deployment documentation for the **current** stack: Node.js (Express)
+ PostgreSQL + JWT + Paystack + Clubkonnect VTU + OpenRouter AI.

> **Note:** the older `DEPLOY.md` describes a pre-PostgreSQL architecture and is
> superseded by this document.

---

## 1. Overview

| What | Where |
|------|-------|
| Node.js app (`server.js`, `Procfile: web: node server.js`) | App host (Railway / Render / Fly / any Docker host) |
| Database | Managed PostgreSQL (Railway Postgres, Render Postgres, Neon, Supabase, …) |
| Domain | Your registrar → point at the app host (HTTPS terminated by the host) |
| TLS | At the host's edge (H2/proxy); the app trusts it via `TRUST_PROXY=1` |

The app is a 12-factor style web service: stateless, reads all configuration
from the environment, stores state only in PostgreSQL. It can run on any host
that runs `node server.js` (or the provided Dockerfile).

---

## 2. Environment variables

See **OPERATIONS.md → Environment variable reference** for the complete list
with required/optional/test-only classification.

**Hard requirements (the app fails fast at startup in production if any are
missing):**

```
NODE_ENV=production
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DB?sslmode=require
JWT_SECRET=<64+ random hex>
APP_URL=https://topflowng.com
PAYSTACK_SECRET_KEY=sk_live_...
CLUBKONNECT_USER_ID=...
CLUBKONNECT_API_KEY=...
```

> **Mandatory integrations:** `PAYSTACK_SECRET_KEY` and `CLUBKONNECT_*` are
> required for **every** production deployment — wallet top-up (Paystack) and VTU
> sales (Clubkonnect) are the platform's only money-moving flows and there is no
> supported payments/VTU-disabled mode. Keep them in the required set and do not
> weaken this check: boot-time validation only proves a value was supplied;
> authenticity is confirmed by each provider on the first live call. There is
> intentionally no opt-out flag — pausing payments is expressed operationally
> (stop routing traffic), never by booting without the keys.

**Strongly recommended:** `RESEND_API_KEY` (password reset / purchase emails),
`PAYSTACK_WEBHOOK_SECRET`, `SENTRY_DSN`, `OPENROUTER_API_KEY` (AI assistant),
`TRUST_PROXY=1`.

Never commit `.env`. Set variables via your host's config UI/CLI.

---

## 3. Database

### 3.1 Provision PostgreSQL
Create a Postgres database (Railway/Render/Neon/Supabase) and export its
connection string as `DATABASE_URL`. Managed hosts already append
`?sslmode=require`/`verify-full`. For a TLS-less database (local/CI) append
`?sslmode=disable` explicitly — this is honoured by `database.js` and
`migrations/migrate.js` (see `lib/dbconn.js`).

### 3.2 Schema & migrations
Two mechanisms exist and both are idempotent:

- **Boot-time schema init** (`database.js → initDB()`) uses `CREATE TABLE IF NOT
  EXISTS` + `ADD COLUMN IF NOT EXISTS`. Safe to run on every boot.
- **Versioned migrations** (`migrations/*.sql` via `migrations/migrate.js`) are
  tracked in `schema_migrations` and applied once, in lexical order, each inside
  a single transaction.

**Deployment migration workflow (recommended, run as the DB owner):**

```bash
# apply pending migrations before starting the new release
DATABASE_URL=postgres://... node migrations/migrate.js
# or, from the project root:
npm run migrate
```

On hosts with a single command (e.g. Docker `CMD`), the entrypoint already runs
`node migrations/migrate.js && node server.js`. The migration runner is safe to
run repeatedly (skips already-applied versions) — see the migration tests.

### 3.3 Rollback of a bad migration
Migrations are forward-only and transactional. To revert:

1. Identify the offending migration in `schema_migrations` (`SELECT * FROM
   schema_migrations ORDER BY applied_at DESC LIMIT 5`).
2. Write a manual, tested **down** SQL (e.g. `DROP TABLE ...`), run it in a
   transaction, then `DELETE FROM schema_migrations WHERE version = '00X_...'`.
3. Redeploy the previous release (the boot-time `IF NOT EXISTS` schema code
   tolerates the older schema).
4. Never edit an already-applied migration file — add a new `00N_` migration
   instead.

### 3.4 Backups & restore
See **OPERATIONS.md → Backups** for the `pg_dump`/`pg_restore` procedure and
the backup-verification routine.

---

## 4. Running with Docker

```bash
docker build -t topflowng .
docker run --rm -p 3000:3000 --env-file .env topflowng
```

- Image base: `node:20-alpine`, non-root `node` user, `npm ci --omit=dev`.
- Entrypoint: `node migrations/migrate.js && node server.js`.
- Healthcheck (liveness): `GET /api/health` (built into the image).
- Orchestrators gate traffic on **readiness**: `GET /api/ready`.

Deploy the image on Railway/Fly/Render/any K8s by pointing at your registry tag
and setting the environment variables.

---

## 5. Health checks & traffic gating

| Endpoint | Type | Semantics |
|----------|------|-----------|
| `GET /api/health` | **liveness** | Process is up and answers HTTP. No dependencies probed. |
| `GET /api/ready` | **readiness** | Process is up **and** the database is reachable (`SELECT 1`). |

- Configure the host to send **readiness** probes to `/api/ready` and only send
  traffic to instances that return `200`.
- Configure **liveness** probes to `/api/health` (restart on failure).
- Both endpoints return minimal JSON and never expose configuration, stack
  traces, database URLs, or credentials.

---

## 6. HTTPS, proxy and cookies

- **HTTPS:** terminate TLS at the host's edge. The app is HTTP inside the
  container. Set `TRUST_PROXY=1` (default) so Express trusts the proxy's
  `X-Forwarded-For`/protocol headers for rate limiting and secure assumptions.
- **Cookies:** the app returns JWT in JSON response bodies (not cookies), so
  there are no cookie flags to manage; the client stores the token in its own
  storage. Keep the site strictly HTTPS so tokens are never sent in cleartext.
- **CORS:** `APP_URL` is the allow-listed origin (with credentials). Any change
  to the public domain must be reflected in `APP_URL`.

---

## 7. Release checklist

1. Run all quality gates locally/CI green: `npm run test:syntax`,
   `npm run test:frontend`, `npm test`, `npm run test:browser`.
2. `npm run audit:prod` — no new high/critical advisories for the release.
3. Confirm `DATABASE_URL` points at the intended database (never a local/dev DB).
4. If this release adds SQL files, test `npm run migrate` against a staging copy
   first, then apply against production **before** scaling the app up.
5. Set/rotate required env vars on the host (never commit them).
6. Deploy the new build; verify `/api/ready` returns `200` before routing traffic.
7. Run the **post-deployment smoke test** (OPERATIONS.md → Post-deployment
   smoke test).

---

## 8. Rollback procedure (application)

If a release misbehaves:

1. Halt new traffic: remove instances from rotation (or scale down).
2. Redeploy the previous known-good commit/image tag.
3. The previous release is forward-compatible because boot-time schema init is
   idempotent (`IF NOT EXISTS`) — as long as no *new* migration was already
   applied that the old code cannot tolerate. See §3.3 if a migration must also
   be reverted.
4. Verify `/api/ready` + smoke test, then restore traffic.

---

## 9. Post-deployment smoke test

Run after every release (scripted or manual):

```bash
curl -sf http://127.0.0.1:3000/api/health        # 200 {"status":"ok"}
curl -sf http://127.0.0.1:3000/api/ready         # 200 {"status":"ready"}
curl -sfI https://topflowng.com/topflowng.html   # 200, no-store not required
curl -s -o /dev/null -w '%{http_code}\n' https://topflowng.com/.env  # 404
# one real user flow: login → wallet balance → register (staging), no 5xx spike
```

Watch logs for `level:error` and Sentry for new issues during the first 15 min.
