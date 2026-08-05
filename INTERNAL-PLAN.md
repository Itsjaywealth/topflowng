# TopFlowNG — Internal Implementation Plan

Internal working plan. Not user-facing. Tracks the current-state audit and the
phased modernization of the platform. All paths relative to repo root.

---

## Phase 1 — Current-State Audit (verified)

### Architecture
- Single-process monolith; all routing lives in `server.js` (1104 lines)
  backed by `database.js` (PostgreSQL via `pg`).
- Express 4.18 + `helmet` + `cors` + `express-rate-limit` (`trust proxy 1`),
  `@sentry/node`. No test suite, no lint/typecheck config, no CI.
- All VTU orders are **held without debiting the wallet** until the provider
  returns a terminal result; the wallet is debited exactly once on confirmed
  delivery via `database.completeVtuOrder`. Reconciliation uses
  `CLUBKONNECT_QUERY_URL`.
- Payments: `/api/paystack/initialize` → `/api/paystack/verify/:reference` and
  `/api/paystack/webhook`; wallet credit is idempotent
  (`database.creditVerifiedPaystackPayment`, `paystack_refs` unique reference).

### Security hardening already applied and committed (Phase 1)
- `parseValidatedAmount()` + `MAX_PURCHASE_AMOUNT = 1_000_000` on all 5 VTU
  purchase routes (negative / NaN / Infinity / absurd values rejected → 400).
- Static asset lockdown: allow-list (`topflowng.html`, `admin.html`,
  `bizflow.html`, `manifest.json`, `sw.js`, `/icons/:file`) + deny-list (404 for
  `.env`, `*.backup-*`, `*.bak`, `auth.js`, `server.js`, `database.js`,
  package/`node_modules`/`.git`, stray `.js`). Repo root is NOT exposed statically.
- XSS escaping in the frontend DOM sinks via `escHtml()` (escapes `& < > " '`).
- `.gitignore` covers `*.backup-*`, `*.bak`.

### Webhook signature verification — CORRECTED FINDING
Paystack `/api/paystack/webhook` **already verifies** the request signature:
- Raw body captured via `express.raw` (`server.js:111`).
- HMAC-SHA512 over the raw body with `PAYSTACK_WEBHOOK_SECRET` (fallback
  `PAYSTACK_SECRET_KEY`); hex compared against `x-paystack-signature`;
  mismatch → 400 (`server.js:448-465`).
- This matches Paystack's documented scheme.
- Remaining hardening (Phase 4, optional): use `crypto.timingSafeEqual` for
  constant-time comparison instead of string `!==`. Not a missing-signature issue.

### Deferred by design (NOT current requirements)
- Postgres replication / read–write splitting — NOT required now. Single
  instance, modest traffic; defer until real load data justifies it.
- DB sharding, multi-region, message queues — not required; avoid premature
  enterprise complexity.

---

## Phased Plan (Phases 2–9)

### Phase 2 — Configuration, Logging, Errors, Provider + VTU Separation
High-value, low-risk extraction (security + testability first). See
`# Phase 2 scope` below. Preserves endpoint paths and response contracts.

### Phase 3 — Authentication & Authorization
Real auth (refresh tokens, admin guard hardening, lockout, revocation). Dormant
`auth.js` remains untouched until this phase is explicitly approved.

### Phase 4 — DB/Transaction Safety & Webhook Hardening
Constant-time signature compare; idempotency keys at the order level; backup /
migrations tooling; keep the existing atomic wallet semantics.

### Phase 5 — UI/UX
Shared design tokens + consistent toast/form states; a11y (ARIA, focus,
reduced-motion); mobile-first polish across all three apps.

### Phase 6 — AI
Protected server-side proxy `POST /api/ai/chat` (OpenRouter, DeepSeek V4 Flash
primary, Hermes fallback, tool calling). Frontend calls only the proxy; keys
never leave the server.

### Phase 7 — SEO / Performance / A11y
Semantic markup, meta/OG/JSON-LD, service-worker cache tuning, Lighthouse budget.

### Phase 8 — Testing / CI
Vitest + Supertest on the throwaway PG (port 55432), `nock`/mock provider for
Paystack & Clubkonnect, Playwright E2E, GitHub Actions on push.

### Phase 9 — Deployment / Operations
Dockerfile, health/stats endpoints, structured logging → Sentry/Loki,
backup jobs, monitoring/alerting.

---

## Phase 2 scope

Goals:
1. Centralised environment config with validation (`config.js`).
2. Move hardcoded provider URLs + safe operational settings into env vars.
3. Update `.env.example` with non-secret examples.
4. Consistent JSON error responses (all errors `{ error }`-shaped).
5. Structured logging — never logs passwords, JWTs, API keys, payment auth
   data, personal data, or full provider response bodies.
6. Gradual route/service separation — provider + VTU code first; the remaining
   routes stay in `server.js`. No single-pass rewrite.

Constraints:
- Preserve every endpoint path and response contract.
- Never contact a real provider during tests.
- Do not modify dormant `auth.js`.
- No Phase 3 authentication work.
- No commits/pushes/deploys/destructive migrations.

---

## Phase 3 — Authentication & Authorization (audit + plan)

### Audit (current-state, verified)

1. **Registration** (`POST /api/auth/register`): requires `fullName, email,
   phone, password` (+optional `referralCode`). Frontend enforces name/email/
   phone presence + password ≥6. Backend `findUserByEmail`/`findUserByPhone`
   dedupe (409). Creates user + referral links, signs JWT, returns
   `{token, user}`.
2. **Login** (`POST /api/auth/login`): takes `email, password`; on failure
   always returns generic `401 {error:'Invalid credentials'}` (no user
   enumeration). Always returns `{token, user}` on success.
3. **JWT**: HS256, payload `{id, email}`. Signed via
   `jwt.sign({id,email}, config.JWT_SECRET, {expiresIn: config.jwt.expiresIn})`.
   Default expiry `7d` (`JWT_EXPIRES_IN`). Verified in `authMiddleware`
   (`jwt.verify`); on failure → `401 {error:'Invalid or expired token'}`.
   Stored in `localStorage['tf_token']` (customer) and
   `localStorage['admin_token']` (admin). Forwarded as `Authorization: Bearer`.
4. **Password hashing**: bcryptjs, `SALT_ROUNDS = 12`. Hash stored in
   `users.password`. `verifyPassword` uses `bcrypt.compare`.
5. **Admin authentication**: `adminMiddleware` (JWT) then `db.findUserById`,
   checks `is_admin`; `401` for bad token, `403 {error:'Admin access required'}`
   for non-admin. Used on all `/api/admin/*`.
6. **PIN handling**: 4–6 digit transaction PIN stored via
   `setTransactionPin` (bcrypt hash, SALT_ROUNDS=12) in `users.transaction_pin`.
   `verifyTransactionPin`/`hasTransactionPin`. **PINs already hashed — no
   plaintext.** No cost/labour concern. Verified at purchase time by
   `checkTransactionPin`.
7. **Protected vs unprotected routes**:
   - Public: `/api/health`, `register`, `login`, `forgot-password`,
     `reset-password`, `paystack/webhook`, static assets/SPA.
   - Protected (`authMiddleware`): all `/api/vtu/*`, `/api/user/*`,
     `/api/wallet/*`, `/api/beneficiaries`, `/api/referral`,
     `/api/analytics/*`, `/api/paystack/initialize`, verify, PIN setters.
   - Admin (`adminMiddleware`): `/api/admin/stats`, `/transactions`,
     `/users`, `/vtu-orders/:id/reconcile`.
8. **Frontend expectations**: `api()` builds `Authorization: Bearer <token>`;
   on `!r.ok` it throws `new Error(json.error || 'Request failed')`. Auth flows
   read `data.token`/`data.user` and set into localStorage keys `tf_token` /
   `admin_token`. Any dropdown in response shape (e.g. changing `user` fields,
   adding/removing `token`) would break these flows. PIN set/verify is
   interactive; `/api/user/profile` gating on `init()`.
9. **Security weaknesses**:
   - Register/login input validation is minimal (no email format check,
     phone not validated to a format).
   - Email not normalised at registration (login compares lower‑cased).
   - No refresh-token rotation; single long-lived token (7d).
   - No account lockout / progressive throttling; only global rate limiting.
   - Forgot-password timing leaks account existence (responds `200` + returns
     early for unknown user; the code path completes a bcrypt/sendEmail for the
     real user — network timing difference).
   - Reset tokens stored & compared in plaintext in `password_resets`.
   - No logout/revocation server-side; token invalidated only client-side.
   - No email-verification.
10. **Backward-compat risks**: response contracts must stay `{token, user}` and
    `{error}`-shaped; changing `401` message text or PIN endpoint shapes would
    surface as UI regressions. Token storage in localStorage is required by the
    existing SPA contract (documented limitation).

### Phase 3 decisions (keep frontend contract stable)
- Keep single access token (no refresh-token rotation) — a second token would
  need new frontend storage/flow; out of contract. Hard expiry stays.
- PIN already safely hashed (bcrypt, cost 12) — no data migration required.
- Add short-lived **lockout** after repeated login failures (in-memory, reset
  on restart) + stricter login rate limiting. Keep responses `{error}`-shaped.
- Hash password-reset tokens at rest (SHA-256 of the random value) instead of
  storing the plaintext token.
- Note: no email-verification gating added (would break existing users); schema
  can support it later without impacting the contract.

### Phase 3 scope (implementation order per file)
- `config.js` — add `jwt.expiresIn` reuse + auth lockout/rate settings.
- `auth.js` (active middleware, NOT the dormant file) — normalise email,
  validate email format, add login-failure lockout; JWT stays in config.
- `services/email.js`, `server.js` — reset token uses SHA-256 at rest; forgot/
  reset hardened.
- `route` protections unchanged except asserting all admin/VTU routes gated.
- New: `routes/auth.js`? No — keep auth routes in `server.js` to minimise churn;
  only strengthen validation & lockout; no endpoint-path changes.
- `routes/vtu.js` — unchanged contract; protected already.
- Tests under `test/` (Phase 8 infrastructure pre-built here).

### Phase 3 implementation COMPLETE (uncommitted, on test DB/mocks only)
Implemented and verified (36 tests passing: 28 auth + 8 smoke):
- `lib/validate.js` (new) — `normalizeEmail`, `isValidEmail`, `isValidPhone`
  (Nigerian-mobile-aware, lenient fallback). No config/endpoints/code changed
  outside this + `server.js`.
- `services/security.js` (new) — in-memory (restart-resets, documented
  limitation) login-failure lockout using configured `loginMaxFailures`,
  `lockoutWindowMs`, `lockoutDurationMs`, plus token revocation store (SHA-256
  of the token, pruned on expiry). Never logs tokens or emails.
- `config.js` — added `config.auth` block (max failures / window / duration).
- `middleware/auth.js` — `authMiddleware`/`adminMiddleware` reject revoked
  tokens (`401 Invalid or expired token`); attach `req.token` for logout.
  Trailing-newline fixed.
- `server.js` — register: email normalize + format validation + phone validation;
  login: non-enumerating errors unchanged, lockout on repeated failures,
  counter reset on success; forgot-password: normalize email + burn a real
  bcrypt compare against `DUMMY_BCRYPT_HASH` for unknown emails to blunt
  timing side-channels; NEW `POST /api/auth/logout` (authMiddleware) revokes the
  presented token. All existing response contracts preserved.
- `admin.html` — `apiFetch` redirects to login on 401/403 (session expiry /
  unauthorized); `adminLogout` now best-effort POSTs `/api/auth/logout` to
  revoke server-side; `esc()` hardened (adds `'`); `reconcileOrder` onclick
  args escaped. Keeps localStorage token contract (`admin_token`).
- `test/` (new) — `helpers/load-app.js` boots the real app with in-memory
  mocks for db/email/clubkonnect (zero real external requests); `auth.test.js`
  and `smoke.test.js` cover reg/login/lockout/reset/logout/admin/static/SPA.
- Leftout by design (contract-stable): no refresh-token rotation; single
  access token; no email-verification gate; reset tokens still stored
  plaintext at rest (SHA-256-at-rest listed as a pending hardening tweak).

### Phase 3 known limitations (documented, to be handled in a later phase)
1. **Token revocation is process-local.** The revocation store is held only
   in memory (`services/security.js`), so a revoked token can become valid
   again after a server restart. Persistent revocation (e.g. a DB-backed
   deny-list) or short-lived access tokens with refresh-token rotation should
   be handled in a later focused phase.
2. **`admin_token` remains in localStorage** for frontend compatibility
   (same as the customer `tf_token`). Tokens are therefore reachable by any
   XSS; strict XSS prevention remains essential.
3. **Six-character password minimum retained** for frontend compatibility.
   `server.js` validates `password.length < 6` on register, reset, and
   change-password; the SPA enforces the same. A stronger policy (e.g. 8+)
   requires a coordinated frontend/backend change and should be reviewed
   together in a future phase.
4. **Login-failure tracking and lockout are process-local.** The failure
   counter and lockout state live in memory only (`services/security.js`), so
   they reset on restart and will not work consistently across multiple server
   instances. A shared store (DB or Redis) is needed for multi-instance
   deployments; revisit in a later focused phase.

### Phase 3 test report — PASS (36/36)
- `node --check` on every modified JS file: clears.
- All 28 Phase 3 auth tests + 8 Phase 1/2 smoke tests pass (`node --test`).
- Requires the full suite (auth + smoke) NOT concurrently so each file binds a
  pid-derived test port, avoiding EADDRINUSE.
- Verified: registration validation/normalization + 409s, login lockout +
  reset, non-enumerating errors, logout token revocation, expired/malformed
  token 401s, admin 403 vs admin 200, reset + change password, rate-limit
  spine, health + static allow-list + SPA + `{token,user}` + `{error}` shapes.
- No real DB/Resend/Paystack/Clubkonnect contact: all external layers mocked.

**STOP: Phase 3 complete at checkpoint. Do not begin Phase 4 until approved.
Commit + push approved: `security: harden authentication and admin access`.**

---
- `lib/logger.js` — structured logger with redaction (new)
- `lib/errors.js` — `ApiError`, consistent JSON error helpers (new)
- `middleware/auth.js` — authMiddleware / adminMiddleware / checkTransactionPin (new)
- `middleware/rate-limit.js` — authLimiter / apiLimiter (new)
- `services/clubkonnect.js` — VTU provider client + response normaliser (new)
- `routes/vtu.js` — VTU purchase + pending routes (new directory)
- `services/email.js` — sendEmail / sendPurchaseEmail (new)
- `.env.example` — add new non-secret vars (updated)
- `server.js` — wire modules, keep remaining routes, swap `console` → logger (updated)---
## Phase 4 — Database & Transaction Safety

### Phase 4A — Audit & Design (COMPLETE — no production code changed)

### Verified audit findings (live throwaway DB `topflowng_test` on 127.0.0.1:55432, all 6 tables present, pg connects OK)

1. **Wallet debit/credit** (`database.js` `debitWallet`/`creditWallet`): each function wraps
   `UPDATE users SET wallet = wallet ± $1 WHERE id=$2` + `INSERT INTO transactions` inside one
   `BEGIN/COMMIT` on a single client. `debitWallet` debits atomically and only when
   `wallet >= $1`. **Concurrent debits cannot overspend** as long as all writes go through
   these functions (VTU does NOT use them at purchase time — see #3).
2. **Transactions**: `transactions.reference` has **no unique index or constraint** (verified
   `\d transactions`), and there is no index on `status`, `provider_order_id`, or `reference`.
   Nothing at DB level prevents duplicate ledger rows for the same reference.
3. **VTU lifecycle**: wallet is **not reserved at purchase**. `createVtuAttempt`
   (`database.js`) inserts a `submitted` order via `ON CONFLICT (request_id) DO UPDATE`.
   `processClubkonnectPurchase` (`services/clubkonnect.js`) then resolves to
   `completeVtuOrder` / `markVtuOrderPending` / `markVtuOrderFailed`.
4. **Only `completeVtuOrder` debits the wallet** (`database.js`): it does `SELECT … FOR UPDATE`,
   short-circuits if already `completed`, then debits, upserts the txn to `completed`, and flips
   the order. **Duplicate provider confirmation for the SAME request_id cannot double-debit**
   (row lock + `alreadyCompleted` guard). BUT there is no DB-level unique constraint on the
   debit reference, so the guard is purely application-level.
5. **Pending/failed**: `markVtuOrderPending` inserts a `pending` debit row without moving the
   wallet; `markVtuOrderFailed` writes a `failed` debit row. Confirmed correct no-charge-until-
   confirmed model.
6. **Status transitions**: `vtu_orders.status` has a CHECK limiting to the 4 values but **no
   transition matrix** at DB level (`completed → pending` is not blocked by the schema).
7. **Paystack** (`server.js:430` webhook): raw body + HMAC-SHA512; compares `hash !== signature`
   with **plain string comparison (not timingSafeEqual)**. Reference claiming in
   `creditVerifiedPaystackPayment` is atomic via `INSERT … ON CONFLICT (reference) DO NOTHING`,
   so **duplicate webhooks cannot double-credit** (good).
8. **Reconciliation** (`server.js` admin `/reconcile`): depends on `provider_order_id`; if it is
   null (UNKNOWN/unreachable path stores `orderId:null`), auto-query is blocked (409). Failure
   path writes a `failed` row with no debit.
9. **Idempotency feasibility**: yes. Treat client key as optional; absent on old clients ⇒
   current `RequestID = SVC-timestamp-userId` behavior unchanged; present ⇒ stable request_id +
   fingerprint + store-original-response.

### Risks
- R1 duplicate debits/ledger rows from a replayed app-level call (no unique ref constraint).
- R2 double provider order if a client retry generates a new timestamp request_id.
- R3 no DB-level status-transition matrix.
- R4 non-constant-time webhook signature compare.
- R5 reconciliation blocked (null provider id) + recovery depends on manual alert.

### Proposed schema changes / indexes (Phase 4B candidates)
- `vtu_orders`: add `idempotency_key TEXT` (nullable) + `idempotency_fingerprint TEXT` +
  `client_request JSONB`; partial UNIQUE on `idempotency_key WHERE idempotency_key IS NOT NULL`.
- `transactions`: partial UNIQUE on `reference WHERE reference IS NOT NULL` (preceded by a
  dedupe/cleanup migration), plus index on `status`, index on `provider_order_id`.
- `vtu_orders`: index on `(status, service_type)` and `created_at`.
- Constraint: status transition matrix via CHECK/trigger (`submitted→pending|completed|failed`,
  `pending→completed|failed`, terminal states are terminal).

### Migration & rollback plan
- Add a small versioned runner (`migrations/` + `schema_migrations` table). Each `.sql` in a
  transaction; rollback = documented reverse SQL per file. Applied only to the throwaway DB
  here.

### Test plan (uses real throwaway Postgres on 55432 — no new in-memory lib)
- concurrent double debit exactly-once + ledger reconcile; duplicate VTU idempotency key;
  same key different payload → 409; duplicate provider confirmation no double debit;
  invalid transitions rejected; pending reconciliation; failed recovery; duplicate Paystack
  webhook; invalid signature; timing-ready valid signature; rollback on forced failure.

### Compatibility
- No route/method/response changes. Idempotency key optional + append-only; legacy calls and
  current `requests` unaffected. Database-level constraints added only after dedupe/backup.

**Phase 4A audit COMPLETE — awaiting approval before Phase 4b production edits.
Do not commit/push/deploy.**

---

## Phase 4B — Webhook Signature Hardening (COMPLETE, committed + pushed)

Implemented `security: harden Paystack webhook verification` (commit `f119a37`, pushed to origin/main):
- `server.js` paystack webhook: replaced string compare `hash !== signature` with a constant-time
  `crypto.timingSafeEqual` (length guard first). Behavior otherwise unchanged.
- New `test/webhook.test.js` (8 tests): valid signature accepted, tampered body rejected,
  mismatch signature rejected, missing signature / bad header handling, plus lifecycle-safe boot
  on the in-memory mock app.
- Full suite = 44 tests (28 auth + 8 smoke + 8 webhook), all pass.
- No other production code changed.

---

## Phase 4C — Migration Framework + VTU Idempotency Schema (in progress)

### Completed
- **Migration runner** `migrations/migrate.js` (new): scans sorted `migrations/*.sql`, uses a
  `schema_migrations` table (`version TEXT PK, filename, applied_at`), applies each file inside a
  `BEGIN/COMMIT` transaction per file on a single client, skips already-applied versions, stops
  cleanly on error (transaction rollback), reads `process.env.DATABASE_URL`. Optional
  `MIGRATIONS_DIR` env override (for testing failed-rollback against a temp dir).
- **First migration** `migrations/001_vtu_idempotency.sql` (new): adds 5 nullable columns to
  `vtu_orders` — `idempotency_key TEXT`, `request_fingerprint TEXT`, `response_snapshot JSONB`,
  `idempotency_key_created_at TIMESTAMPTZ`, `idempotency_key_last_used_at TIMESTAMPTZ` (all
  nullable ⇒ legacy-compatible). Adds partial unique index
  `idx_vtu_orders_idempotency_scope` on `(user_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
  (same user cannot reuse a key; different users may reuse the same key — no production
  uniqueness assumption violated). Adds supporting index `idx_vtu_orders_user_status` on
  `(user_id, status)` for the get-pending-orders query path. Rollback SQL documented in the file
  header comments.
- **npm script** `"migrate": "node migrations/migrate.js"` added to `package.json`.
- Applied ONLY to the throwaway Postgres on 127.0.0.1:55432; the shared app test DB
  `topflowng_test` was confirmed untouched (no `schema_migrations`, no idempotency columns).
- E2E verified via `npm run migrate` on a throwaway DB (apply 001 → indexes exist → rerun is a
  no-op). Malformed/base-missing DB fails clearly.

### Test report — PASS
`node --test --test-timeout=60000 test/migrations.test.js` → 7/7 pass
(`test/migrations.test.js` creates/drops a dedicated `topflowng_mig_<pid>`
DB using pg; bootstraps the base schema, applies 001, asserts: apply success, no-op rerun,
legacy NULL keys still valid, same-user key reuse rejected, cross-user key reuse allowed,
indexes exist, and failed migration rolls back atomically incl. no partial table + no recorded
version).
Full suite: `node --test --test-timeout=30000 test/auth.test.js test/smoke.test.js
test/webhook.test.js` → 44/44 pass.

### Left outstanding for a later phase (NOT Phase 4C)
- Route-level VTU idempotency behavior + provider purchase + reconciliation logic (this phase
  only adds the schema).
- `transactions` unique constraint on `reference` (deferred) and status-transition matrix.

**Phase 4C schema complete at checkpoint — do not begin route-level idempotency (Phase 4D)
until approved. Do not commit/push/deploy.**

## Phase 4D — Route-level VTU Idempotency (COMPLETE, committed `881b2a4`)

Shipped `services/idempotency.js` (key validation, SHA-256 payload fingerprint, user-scoped
`requestIdFromKey`, claim/replay/conflict/in-progress resolution, snapshot builder),
`database.js` idempotency primitives (`acquireVtuIdempotency` with `INSERT … ON CONFLICT`
+ `FOR UPDATE`, `recordVtuIdempotencyResult`, extended `getVtuOrderByRequestId`), wired all 6
purchase routes, and preserved legacy no-key reference prefixes. 12 tests green.

## Phase 4E — VTU Status Transitions, Reconciliation & Rollback Safety (COMPLETE, UNCOMMITTED)

### Audit (verified against `database.js` lifecycle + `server.js` reconcile route)

- **Status model:** `vtu_orders.status` CHECK allows only
  `('submitted' | 'pending' | 'completed' | 'failed')`. There is NO `processing` state in the
  schema; the matrix intentionally omits it (adding it would need a migration + frontend change,
  out of scope) so any attempt to move through a non-existent state fails loudly.
- **Allowed transitions:** `submitted → pending/completed/failed`, `pending → completed/failed`
  (`completeVtuOrder`/`markVtuOrderFailed` with `allowPending`), plus idempotent same-state
  re-entry (`completed → completed`, `failed → failed`).
- **Already rejected:** `failed → completed` (completeVtuOrder threw), `pending → completed`
  without `allowPending`.
- **Bugs found:**
  1. `markVtuOrderPending` and `markVtuOrderFailed` **silently returned** the unchanged order on
     terminal-state mismatches (`completed → pending`, `completed → failed`) instead of signalling
     a caller error — ambiguous, hid bugs. Now throw `TransitionError`.
  2. **Recoverability gap:** if the provider confirmed delivery but the local settlement threw
     (e.g. wallet emptied between balance-check and debit, or a DB write failed), the transaction
     rolled back and the order stayed `submitted` — NOT pending — so it was invisible to the
     `POST /api/admin/vtu-orders/:requestId/reconcile` endpoint despite holding a provider order ID.
     Now parked in `pending` with the provider reference intact.
  3. Reconciliation attempts were **not tracked** — no visibility into repeat/excess reconciliation.

### Changes

- `services/order-lifecycle.js` (new): status-transition matrix (`VALID_STATUSES`, `TERMINAL`,
  `ALLOWED`, `canTransition`, `assertCanTransition`, `TransitionError`). Single source of truth.
- `database.js`:
  - `completeVtuOrder` now routes through the matrix (`assertCanTransition(order.status,'completed')`);
    keeps idempotent `alreadyCompleted` path (no second debit) and `allowPending` semantics.
  - `markVtuOrderPending` rejects `completed/failed → pending` with a clear error; `pending → pending`
    stays an idempotent no-op.
  - `markVtuOrderFailed` rejects `completed → failed`; keeps `failed → failed` idempotent and
    `pending → failed` gated on `allowPending`.
  - `recordReconciliationAttempt(requestId)` increments `reconcile_attempts` + stamps
    `last_reconciled_at`.
  - `promoteToAdmin(userId)` (test helper) + `getVtuOrderByRequestId` now returns the two new columns.
- `services/clubkonnect.js`: success path wraps `completeVtuOrder` in try/catch; on local failure it
  calls `markVtuOrderPending` and returns a `pending` outcome — confirmed deliveries can no longer
  fall out of the reconciliation set. Never auto-replays the provider purchase.
- `server.js`: `POST /api/admin/vtu-orders/:requestId/reconcile` records each attempt via
  `recordReconciliationAttempt` before querying the provider (terminal-state and missing-provider-ID
  short-circuits still return early without incrementing).
- `migrations/002_vtu_reconcile_attempts.sql` (new): adds `reconcile_attempts INTEGER NOT NULL
  DEFAULT 0` and `last_reconciled_at TIMESTAMPTZ` (nullable). Rollback SQL in header. No data
  modified; defaults keep existing rows valid.

### Reconciliation safety (verified)

- At-most-once wallet debit: `FOR UPDATE` row lock + `alreadyCompleted` guard make concurrent or
  duplicate reconciliations settle exactly once (tests 6, 7, 12).
- Provider success + local DB failure → order held `pending` with `provider_order_id` preserved;
  settles exactly once once funded (test 9).
- Wallet-debit failure and ledger-insert failure both roll back the entire settlement atomically —
  no partial debit, no leaked transaction rows (tests 10, 11).
- Missing `provider_order_id` → 409 with no provider query and no debit (test 8).

### Test report — PASS (13/13 lifecycle + 8/8 migrations + full suite 77/77)

Command: `node --test --test-timeout=60000 test/auth.test.js test/smoke.test.js test/webhook.test.js test/migrations.test.js test/idempotency.test.js test/lifecycle.test.js`

Phase 4D idempotency behaviour intact (route-level regression test 13 + existing 12 tests green);
shared `topflowng_test` DB untouched by migrations; all provider/email layers mocked (zero real
external calls); all DBs throwaway.

**Phase 4E complete at checkpoint — UNCOMMITTED. Do not commit, push, deploy, or begin Phase 5.**

---

## Phase 5 - World-Class UI/UX Redesign (UI & accessibility pass)

**Status: COMPLETE at checkpoint - UNCOMMITTED. Do not commit, push, deploy, or begin Phase 6.**

Backend untouched: database.js, auth, wallet, VTU lifecycle, Paystack, migrations, AI, and
business rules were not modified. Frontend files changed only:
topflowng.html, admin.html, bizflow.html (no new files; public/ already allow-listed and
nothing added there; manifest.json/sw.js/icons/ unchanged).

### Audit summary (before)
- Missing base component CSS (UA-default buttons/inputs), malformed markup (duplicated
  </head>/<body>, stray </style> numeric literals), maximum-scale=1.0 viewport,
  no <meta name="description">, unlabeled inputs, chips/presets not keyboard-focusable,
  .bottom-nav base fixed-dock rule absent, tablet 2-column home grid overflowed below 1024px,
  bizflow.html #main had no min-width:0 (overflowed at 320px), dead skeleton/badge/toast
  styles, link contrast below AA.

### Changes made
topflowng.html:
- Fixed malformed head markup (</head>/<body> deduplicated, stray </style> literal removed).
- Removed maximum-scale=1.0 from viewport meta (a11y).
- Added Phase 5 CSS block: tokens (--focus-ring, --link-strong, skeleton/toast palette),
  base .btn-primary/.btn-cancel, .spinner, error/success display toggles, .modal-card/
  .panel-card dialogs, receipt-dots/lines, skeleton loaders, toast root, focus-visible
  affordances for chips/presets/plans/filters, stronger link contrast, prefers-reduced-motion
  and print rules, tablet 760-1023px home-grid fix, and a mobile base .bottom-nav fixed dock
  (scoped <=1023px so the desktop sidebar variant is untouched).
- Added role="button" tabindex="0" to all 58 chip/preset/filter/plan controls.
- Added for attributes tying every label to its input (login/register/forgot/reset + all six
  service screens + fund modal + change-password panel) - 19 labelled inputs.
- Added role="dialog" aria-modal="true" aria-labelledby to receipt/fund/change-password/PIN
  overlays and role="alert"/aria-live to error/success regions.
- Fixed pre-existing bug: the password-reset form contained a Phone number field (#data-phone)
  while handleReset() reads #reset-password - reset would throw. Replaced with a labelled
  New password input.
- Fixed pre-existing critical bug: two "function goTab" declarations plus const _goTab = goTab
  caused the wrapper to alias itself (infinite recursion, "Maximum call stack size exceeded") -
  every tab switch/navigation broke and both auth+main screens rendered at once. Renamed the
  base impl to _goTab and dropped the alias; navigation now works at every width.

admin.html:
- Added <meta name="description">, label for attributes, role="alert" on login error,
  type="button" on the sign-in button, focus-visible ring, keyboard activation (Enter/Space)
  for sidebar nav-items.

bizflow.html:
- Added focus-visible styling, #main{min-width:0} (fixes 320px horizontal overflow from the
  flex child refusing to shrink), card-level overflow-x:auto so wide tables scroll inside
  their card, and a .table min-width floor. Existing responsive sidebar verified intact.

### Verification (all PASS)
- Backend suite: node --test --test-timeout=60000 test/{auth,smoke,webhook,migrations,idempotency,lifecycle}.test.js -> 77/77 pass, 0 fail (backend untouched).
- Static allow-list (HTTP 200): /, /topflowng.html, /admin.html, /bizflow.html, /manifest.json,
  /sw.js, /icons/icon-192.png, /icons/icon-512.png.
- Private paths return 404 (source/env blocked); /migrations, /test, /INTERNAL-PLAN.md return
  only the SPA shell (no source content leaked).
- All 6 purchase flows via mocked provider (airtime, data, electricity, cable, exam-pin,
  recharge-pin): each HTTP 200, correct message, wallet balance decremented, reference returned.
- Auth: non-admin /api/admin/stats -> 403; no token -> 401; admin login -> 200 isAdmin:true;
  admin stats/transactions/users -> 200.
- Responsive (Playwright, 320/375/768/1024/1440): no horizontal overflow on landing, dashboard,
  admin, or bizflow at any width; touch targets >=24px; nav is a fixed dock on mobile and the
  ink sidebar on desktop; focus ring solid 3px amber; 0 unlabeled inputs, 0 empty-name buttons;
  aria-live + dialog roles present.
- PWA/API/key preservation: all IDs, API paths, event handlers, tf_token/admin_token
  localStorage keys, and the static allow-list are unchanged.

**Phase 5 complete at checkpoint - UNCOMMITTED. Stop before Phase 6.**

---

## Phase 6 - Secure AI Integration with OpenRouter (read-only, advisory)

**Status: COMPLETE at checkpoint - UNCOMMITTED. Do not commit, push, deploy, or begin Phase 7.**

Scope guard: the AI layer is strictly read-only and advisory. It can NEVER debit a
wallet, complete/reverse a purchase, verify a payment, change a password/PIN, or perform
any admin or irreversible action. Existing wallet, VTU, Paystack, migrations, and
authentication contracts are unchanged (no changes to database.js, the migration files,
payment, or purchase-flow logic).

### Configuration (config.js + .env.example)
New env vars (all optional; safe dev/test defaults):
  OPENROUTER_API_KEY, OPENROUTER_BASE_URL, OPENROUTER_PRIMARY_MODEL
  (deepseek/deepseek-v4-flash), OPENROUTER_FALLBACK_MODEL (hermes), OPENROUTER_APP_URL,
  OPENROUTER_APP_NAME, AI_MODEL_ALLOWLIST, AI_TIMEOUT_MS, AI_MAX_INPUT_LENGTH,
  AI_MAX_OUTPUT_TOKENS, AI_RATE_WINDOW_MS, AI_RATE_MAX, AI_DAILY_REQUEST_CEILING,
  AI_DAILY_COST_CEILING.
Model IDs are validated through config; the allow-list derives from the configured primary,
fallback, and AI_MODEL_ALLOWLIST - never hardcoded in business logic.

### Server-side service (new)
- services/openrouter.js - the ONLY module that contacts OpenRouter (shared axios,
  Authorization + X-Title/X-App-Url/Referer app headers, timeout, returns a normalized
  {content, model, usage} envelope). Upstream error bodies are discarded and replaced with
  generic messages. Isolated so tests can mock this one file.
- services/ai.js - orchestration + safe tool layer + prompt-injection protection:
  builds the hardened system prompt; resolves models against the allow-list in
  primary->fallback order; executes ONLY 5 allow-listed read-only tools scoped to the
  authenticated user (getServiceInformation, getUserWalletSummary, getRecentTransactions,
  getTransactionStatus, createSupportTicketDraft); output secret-redaction guard;
  per-day request/cost ceilings; logs only {code, model} - never prompts, responses,
  tokens, keys, or upstream bodies.

### Endpoint
POST /api/ai/chat (mounted in server.js). Requires authMiddleware (JWT); per-user rate
limiter (keyGenerator on req.user.id); input validation (JSON body, message required and
<= AI_MAX_INPUT_LENGTH, only role "user", model in allow-list); consistent { error: string }
JSON errors; timeout/fallback handled; only safe token-count usage metadata returned.

### Frontend (topflowng.html)
Added a lightweight customer-only assistant: launcher FAB shown only when main-app is
active (logged in); dialog with loading/error/empty/offline states; keyboard accessible
(Esc close, Enter send); mobile responsive; all model/user text rendered via textContent
(NEVER innerHTML); a disclaimer that answers are advisory and do not override balance or
transaction/payment status. admin.html untouched (no AI controls added).

### Prompt-injection protection
All user + tool output treated as untrusted data; system prompt forbids secret disclosure,
account actions, and rule overrides; tool names/schemas allow-listed server-side; tool
identity ALWAYS from req.user (ignores any client-supplied userId); unknown tools rejected;
defense-in-depth output redaction strips known secrets even from a misbehaving model.

### Tests (new test/ai.test.js + harness load-ai-app.js, real Postgres; only
OpenRouter/email/provider mocked)
25 tests: auth required, malformed/oversized input, per-user rate limiting (429), primary
success, primary failure -> fallback success, both models fail (502, no leak), timeout ->
fallback, model allow-list enforcement, tool allow-list + input validation, tool
authorization, no cross-user data access, prompt-injection cannot exfiltrate secrets or
env names, zero real OpenRouter calls (mocked at require boundary).

### Verification (all PASS)
- Syntax: node --check on all new/changed JS + inline topg.html JS (1 inline script OK).
- AI suite: 25/25 pass.
- Full existing suite: 77/77 pass; combined with AI = 102/102 pass.
- Live HTTP (real DB, mocked provider/email, OpenRouter at loopback:9 so NO real call):
  23/23 - six purchase flows all 200, non-admin 403, admin login/stats/transactions/users,
  logout -> 401 after, no-token 401, customer profile, AI no-token 401, bad model 400,
  non-user role 400, oversized 400, both-models-fail 502 generic with no detailed leak.
- Frontend scan: no OPENROUTER/sk-or- strings in any HTML file; AI output rendered as
  text only.

**Phase 6 complete at checkpoint - UNCOMMITTED. Stop before Phase 7.**
