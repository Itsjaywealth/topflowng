# TopFlowNG — Testing

This describes how to run and extend the automated quality checks for TopFlowNG.
The whole suite is **safe by construction**: it never contacts a real provider,
never touches a shared/production database, and requires **no secrets** (any API
key or token used is a throwaway placeholder; the external layers — Clubkonnect,
Resend/email, OpenRouter — are mocked at the Node `require` boundary).

## Prerequisites

- **Node.js 18+** (recommended 22)** — the suite uses Node's built-in test runner.
- **PostgreSQL** reachable at `127.0.0.1` (or `PG_HOST`). Tests create and drop
  their own throwaway databases via the `pg` package — no `psql` binary
  needed. A local cluster on a non-default port (e.g. `55432`) works by setting
  `PG_PORT`.
- **Chromium (optional, only for browser checks):** `npm run test:browser:install`.

## Library tooling

There is **no extra test framework** beyond Node's `node:test`. Playwright
(`@playwright/test`) is the only new runtime dependency and is used solely for the
optional browser suite. Chromium is never committed; it is downloaded explicitly.

## Commands

| Command | What it runs |
| --- | --- |
| `npm test` | Full suite (no coverage): `node --test test/*.test.js` |
| `npm run test:unit` | DB-less tests (smoke, auth, webhook) — no PostgreSQL needed |
| `npm run test:integration` | DB-backed suites (idempotency, lifecycle, AI) |
| `npm run test:migrations` | Migration-runner + schema tests |
| `npm run test:syntax` | `node --check` on every repo JS/CJS/MJS file |
| `npm run test:frontend` | Static checks: inline-script syntax, SEO/JSON-LD, robots/sitemap/manifest/SW policy, admin `noindex`, AI-safe rendering |
| `npm run test:browser` | Playwright browser checks (responsive, a11y, forms, AI, PWA assets) |
| `npm run test:browser:install` | `playwright install chromium` |
| `npm run test:coverage` | Full suite with built-in coverage report |
| `npm run test:ci` | CI aggregate: syntax + frontend + full suite with coverage |
| `npm run audit:prod` | `npm audit --omit=dev --audit-level=high` (informational) |

Run all unit/integration/migration checks:

```sh
npm run test:ci
```

## Test architecture & isolation

Every database-backed test creates a **dedicated throwaway database** named
`<prefix>_<pid>` (e.g. `topflowng_ai_1234`), applies migrations, runs, and then
**drops the database in `after()`**. Helpers:

- `test/helpers/load-app.js` — in-memory DB, no Postgres (smoke/auth/webhook).
- `test/helpers/load-idempotency-app.js` — real Postgres (throwaway), mocked
  provider/email.
- `test/helpers/load-ai-app.js` — real Postgres (throwaway), mocked
  provider/email/OpenRouter.
- `test/helpers/pg.js` — portable throwaway-DB create/drop (via `pg`, no `psql`).
- `test/browser/harness.cjs` — Playwright webServer: real server on a throwaway
  DB with mocked external layers.
- `test/browser/global-teardown.cjs` — Playwright global teardown: drops any
  leftover throwaway DB after the run (Playwright hard-kills its webServer, so
  this main-process sweep is the authoritative cleanup).

Rules that hold in every test:
- No shared `topflowng_test` database — never modified.
- No test depends on execution order; parallelism is safe because DB names /
  ports are PID-derived.
- No test uses live provider URLs (OpenRouter base is an unreachable loopback
  and the module is mocked; Clubkonnect/email are always mocked).
- Cleanup is best-effort (`closePool` + `DROP DATABASE … WITH (FORCE)`), with a
  deterministic `global-teardown` sweep for the browser harness.

## Environment variables used by tests

All optional, all non-secret placeholders in CI:

| Variable | Default | Purpose |
| --- | --- | --- |
| `PG_HOST` | `127.0.0.1` | Postgres host |
| `PG_PORT` | *(auto-detect)* | Postgres port. When unset, tests probe `55432` (documented throwaway-cluster port) then `5432` (standard local default) and use the first reachable one. Set it explicitly to pin a port (CI sets `5432`). |
| `PG_USER` | `postgres` | Postgres user |
| `PG_PASSWORD` | *(empty)* | Postgres password (`trust` auth) |
| `PG_ADMIN_DB` | `postgres` | Control DB used to create/drop test DBs |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | `0` | Set `1` when installing deps without browsers |

## CI behavior (`.github/workflows/ci.yml`)

Runs on **pull requests** and **pushes to `main`**:

- **test** job — `postgres:16-alpine` service (trust auth), Node 18/20/22 matrix,
  `npm ci`, then `npm run test:ci` (syntax + frontend + full suite with coverage).
  Fails on any failure; no deploy.
- **browser** job — Node 22, `postgres` service, `npm ci`,
  `npx playwright install --with-deps chromium`, `npm run test:browser`; uploads
  the Playwright HTML report on failure.
- **audit** job — `npm audit --omit=dev --audit-level=high` with
  `continue-on-error: true` (informational only).

## Debugging failed tests

- **Unit/integration**: run a single file, e.g.
  `node --test test/idempotency.test.js`. Verbose failure output surfaces first.
- **Browser**: `npm run test:browser` writes a trace/**. Open the HTML report:
  `npx playwright show-report`. Run a single test with `-g "name"`, e.g.
  `npx playwright test -g "no horizontal overflow"`.
- **Coverage**: `npm run test:coverage` prints a per-file table (line/branch /
  function) to help find untested modules.

## Coverage

Coverage uses the Node built-in `--experimental-test-coverage` — no extra
package, reported per file in the terminal. There is **no failing threshold** in
CI; coverage is informational so a low-fidelity assertion can never block a
valid change. Reconsider a threshold only once the baseline is stable and meaningful.

## Dependency auditing

`npm run audit:prod` reports on production regressions. Known finding: **19
moderate** vulnerabilities arrive transitively via `@sentry/node` →
`@opentelemetry/*`. These are moderate (not high/critical), unfixable without a
Sentry major upgrade (out of scope), and do not block CI (`--audit-level=high`).

## No real providers

There is **no code path** in the tests that contacts Clubkonnect, Resend/Paystack
or OpenRouter: they are all replaced by in-memory mocks before any server is
loaded, and the OpenRouter base URL additionally points at an unreachable
loopback. CI sets only placeholder secrets and `POSTGRES_HOST_AUTH_METHOD: trust`.