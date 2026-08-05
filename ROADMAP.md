# TopFlowNG — Roadmap to a World-Class SaaS

Prioritized from highest to lowest impact. Money and security first, then SaaS foundation,
then operations, then growth, then frontier. Every item is grounded in the current codebase.

Priority summary (top → bottom):

| # | Area | Why first |
|---|------|-----------|
| 1 | **Security & Fraud** | holds money; cannot ship without |
| 2 | **Payments & Ledger** | revenue & user-trust core |
| 3 | **Testing** | unlocks safe, fast evolution |
| 4 | **Auth & RBAC** | secure & revocable access |
| 5 | **Observability** | you can't run what you can't see |
| 6 | **Deploy / CI-CD** | repeatable, safe change |
| 7 | **Admin & Ops** | daily operations + ledger |
| 8 | **Notifications** | engagement + security |
| 9 | **Performance** | quality under load |
| 10 | **UX / Onboarding** | retention |
| 11 | **Product Analytics** | measure growth |
| 12 | **SEO / Marketing** | acquisition |
| 13 | **AI** | differentiating later |
| 14 | **Scaling** | only when needed |

---

## TIER 1 — Do not run without these

### 1. Security & Fraud
- Server-side pricing/plan catalog — never trust client `amount`.
- Positive, finite, bounded amount validation on all `/api/vtu/*` routes.
- Stop serving the repo root (`express.static(__dirname)` + `*` SPA fallback). Serve only from `public/`; block `.env`, `.git`, `*.backup-*`, `*.bak`, `auth.js`.
- Escape all rendered HTML (`txnHTML()` stored-XSS).
- Remove committed source backups from git history.
- Strict CSP; secrets in a vault manager; restrict VUN scope; least-privilege DB.

### 2. Payments & Wallet Integrity
- Preserve the existing exactly-once idempotency (atomic `INSERT/COMMIT`, webhook HMAC).
- Add a **financial ledger** and nightly reconciliation job:
  Paystack ↔ `transactions` ↔ live wallet balance; alert on any drift.
- Exactly-once debit on purchases (already at DB layer — keep); idempotent both webhook and callback.
- Webhook retry with exponential backoff; processed-event dedup.

---

## TIER 2 — SaaS foundation

### 3. Testing
- Unit: pricing catalog, `normalizeClubkonnectResponse`, amount validation, JWT helpers.
- Integration (supertest + PG test DB): VTU order state machine (`submitted → pending → completed|failed`), Paystack webhook verify-and-credit, refund / no-double-credit.
- Frontend E2E (Playwright): fund wallet → buy → receipt → pending reconciliation.
- `npm test` as a CI gate.

### 4. Authentication & Authorization
- Access token (short-lived) + rotating, revocable refresh tokens with reuse detection.
- Account lockout, throttled signup, verification email.
- MFA / TOTP for admin.
- **RBAC** with `customer | admin | support | audit` roles instead of `is_admin` boolean.

### 5. Observability & Monitoring
- Structured JSON logging (request IDs) with an event-lifecycle for webhook/reconciliation.
- Metrics: payment success rate, wallet drift, pending-order age, provider latency, refund rate, 5xx.
- Alerts for: unstuck pending orders, failed webhook, wallet↔ledger drift, error spikes.
- RUM for Core Web Vitals.

---

## TIER 3 — Operations

### 6. Deployment & CI/CD
- Lint/type/test CI pipeline (currently none).
- Staging with production parity (build + migrations + DB).
- Proper DB migrations (replace ad-hoc `CREATE TABLE IF NOT EXISTS`).
- Secrets rotation + env management; pipeline-based deploy instead of bare `git push`.

### 7. Admin & Operations
- In-app admin creation + role assignment (currently impossible via UI).
- Scheduled, guarded auto-reconciliation job on top of the existing manual reconcile.
- Support tooling: look up any user, refund, view-only impersonation.
- Audit log of admin actions.

### 8. Notifications
- Transactional email for every completed order (Resend scaffold exists — extend).
- Opt-in push (Web Push) for order status changes + security events.
- In-app notification center with badge.

---

## TIER 4 — Product & growth

### 9. Performance
- Split the huge inline HTML (markup/JS/CSS) into static assets; cache headers; HTTP/2; web images.
- Optimize queries; cache admin metrics; pool/config tuning.
- CI performance budget.

### 10. UX / Onboarding
- Standardize on the Flow Green design system; shared components.
- Guided first purchase per service; reorder-last; prefilled beneficiaries.
- Honest message for pending states; one-tap recharges; full accessibility.

### 11. Product Analytics
- Track event funnels (fund → buy → refill), retention, cohorts.
- Owner dashboard: GMV, margin, COGS, usage churn — tie every item to a metric.

### 12. SEO / Marketing
- Static marketing/landing site (features, pricing, FAQ) — separate from the SPA.
- Structured data, sitemap, meta; market SEO for airtime/data/etc.
- A product is the priority; marketing follows once reliable.

---

## TIER 5 — Frontier (only after the foundation)

### 13. AI
- Support copilot over order/provider histories.
- Purchase anomaly / fraud detection.
- Demand & cash-flow forecasting for top-ups.
- Deliberately last: needs rich structured data + a measured business case.

### 14. Scaling
- Queue provider calls out of the request path (Redis-backed worker).
- Read replicas for admin/analytics; Redis for rate-limits/cache/sessions.
- Horizontal web dynos + region-friendly (NG) placement.
- Only when approach is validated — avoid premature scaling.