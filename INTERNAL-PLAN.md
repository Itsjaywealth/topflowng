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

Files introduced/updated (Phase 2):
- `config.js` — validated environment configuration (new)
- `lib/logger.js` — structured logger with redaction (new)
- `lib/errors.js` — `ApiError`, consistent JSON error helpers (new)
- `middleware/auth.js` — authMiddleware / adminMiddleware / checkTransactionPin (new)
- `middleware/rate-limit.js` — authLimiter / apiLimiter (new)
- `services/clubkonnect.js` — VTU provider client + response normaliser (new)
- `routes/vtu.js` — VTU purchase + pending routes (new directory)
- `services/email.js` — sendEmail / sendPurchaseEmail (new)
- `.env.example` — add new non-secret vars (updated)
- `server.js` — wire modules, keep remaining routes, swap `console` → logger (updated)