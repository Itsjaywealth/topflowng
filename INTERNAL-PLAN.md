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
