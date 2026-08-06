# TopFlowNG — Security Checklist

Audit checklist covering the "Security & resilience" gate for production
deployment. Launch only when every item is satisfied.

---

## Transport & trust

- [ ] **HTTPS end-to-end:** TLS terminated at the edge; the app runs on HTTP
      behind the proxy. Confirm the public origin is HTTPS (`APP_URL`).
- [ ] **Proxy trust is deliberate:** `TRUST_PROXY=1` (default) is only correct
      when a TLS-terminating proxy/load balancer sits in front. If the app is
      directly internet-facing, set `TRUST_PROXY=0` to prevent
      `X-Forwarded-For` spoofing.
- [ ] CORS allow-list is the single `APP_URL` origin with `credentials: true`;
      not `*`.

## Tokens, sessions, payment

- [ ] **No secure-cookie changes needed:** the app returns the JWT in JSON
      bodies, not cookies — so there are no cookie flags to manage. Never fall
      back to storing the JWT in a cookie without adding `Secure`/`HttpOnly`
      handling.
- [ ] **JWT secrets are strong and unique** (>64 chars), never the dev default.
      In production the app refuses to boot with a missing/weak secret.
- [ ] Payment credits are **idempotent** (`paystack_refs`) and only banked after
      verified provider/Delights success; VTU uses the provider query API.

## Rate limiting / abuse

- [ ] Auth routes limited (`AUTH_RATE_MAX`, default 10/window); API routes
      limited (`API_RATE_MAX`, default 60/min); login lockout enforced.
- [ ] Limits are tunable via env; defaults are conservative. Note limits are
      per-instance in-memory (see OPERATIONS scaling).

## Client / service worker

- [ ] **Service worker never caches private data:** SW excludes `/api/*` and
      auth/admin routes (strict no-store for API responses confirmed by static
      checks). Confirm `sw.js` never-Caches authenticated content.
- [ ] Static range that serves the SPA is an allow-list; far-future caching is
      limited to versioned image assets (not HTML/manifest/SW).

## Source & secrets exposure

- [ ] Source file protection is on: `/server.js`, `/database.js`, `/config.js`,
      `/auth.js`, `/package*.json`, `node_modules/*`, `.git/*`, `.env`, and
      backup files return **404** (verified by smoke + static tests).
- [ ] `.env` and backups are gitignored and never deployed; the container does
      not include them.
- [ ] Logs redact secrets; health endpoints (`/api/health`, `/api/ready`) never
      leak connection strings, DB URLs, credentials, or stack traces (tested).

## Authorization

- [ ] All `/api/admin/*` routes require `adminMiddleware` (admin-only, real user
      from DB): `stats`, `transactions`, `users`, `vtu-orders/:id/reconcile`.
- [ ] User-scoped routes require `authMiddleware` and are keyed to `req.user`.

## Configuration & fail-safe

- [ ] Production **fails fast** at startup if a required secret is missing
      (only variable names are reported, never values).
- [ ] No default or fake production secrets are accepted: the dev JWT fallback
      is only used in non-production.

---

## Launch checklist (summary)

- [ ] All checklist boxes above green.
- [ ] `npm run audit:prod` passes (no new high/critical).
- [ ] Full test suite green: `npm run test:syntax`, `test:frontend`, `npm test`,
      `test:browser`.
- [ ] Readiness `/api/ready` wired into the host health check.
- [ ] Backups enabled + **verified** (OPERATIONS §5).
- [ ] Sentry + alerts configured (RUNBOOK §1).
- [ ] Signed off by a second reviewer before traffic is opened.