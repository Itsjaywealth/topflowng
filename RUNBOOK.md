# TopFlowNG — Operations Runbooks

Alert matrix, incident runbooks, and operational procedures. For deployment
mechanics see **DEPLOYMENT.md**; for environment variables, backups and scaling
see **OPERATIONS.md**.

---

## 1. Alert matrix

| Condition | Detection (log / probe / Sentry) | Severity | Runbook |
|-----------|---------------------------------|----------|---------|
| Elevated HTTP 5xx | `level:"error"`, `status:5xx` per minute | P1/P2 | §2 |
| Paystack webhook verification failure | `"Invalid Paystack webhook signature"` | P1 | §3 |
| Reconciliation failures | `reconcile` errors, VTU orders stuck `pending` | P2 | §4 |
| Repeated provider failures | Clubkonnect / OpenRouter error spike | P2 | §5 |
| Database connection failure | `/api/ready` **503**, pool/login errors | P1 | §6 |
| AI provider failures | OpenRouter errors, cost-ceiling breach | P2 | §5 |
| Rate-limit / lockout spike | `429`, `isLockedOut` logged | P2 | §7 |

Severity: **P1** = money impact, data loss risk, or total outage; **P2** =
degraded/unavailable feature; **P3** = watch only.

---

## 2. Elevated 5xx errors

1. Check `/api/ready` — if **503**, start at §6.
2. Pull the failing `X-Request-Id` from logs / Sentry; correlate affected users.
3. Was a release just shipped? If so, roll back (§11).
4. Check provider health (Clubkonnect / Paystack / OpenRouter) — outages surface
   as 5xx on their routes.
5. Grep Sentry for the dominant exception in the window.

---

## 3. Paystack webhook verification failure

Log: `"Invalid Paystack webhook signature"`, HTTP 400 to Paystack.

1. Confirm `PAYSTACK_WEBHOOK_SECRET` (fallback: `PAYSTACK_SECRET_KEY`) matches
   the Paystack dashboard.
2. Confirm the webhook is `charge.success` and the key is the live `sk_live`.
3. Repeated failures with real payments ⇒ key mismatch → rotate carefully.
4. Wallet credit is idempotent (`paystack_refs`); a single delivery can never
   create a duplicate credit. The client VERIC route also re-syncs a payment.

---

## 4. Reconciliation (VTU orders stuck pending)

`POST /api/admin/vtu-orders/:requestId/reconcile` returns 502, or orders stay
`pending`.

1. Verify the order has a `provider_order_id` (without it, cannot auto-query).
2. Re-run reconcile — each attempt records `records a new reconciliation` and
   the provider's current outcome drives settlement.
3. If the provider is down, treat as a provider outage (§5) and wait/retry.
4. Never hand-credit a `pending` order without a provider-confirmed `success`.

---

## 5. Provider outages — VTU provider + AI (OpenRouter)

- **Clubkonnect:** verify egress IP is whitelisted in the provider dashboard;
  confirm the dev base/query URLs are correct; run one reconcile to test.
- **OpenRouter (AI):** read-only/advisory — never moves money. Check
  `OPENROUTER_BASE_URL`, the key, and any daily cost-ceiling breach.

---

## 6. Database connection failure

1. `/api/ready` **503**; liveness may stay 200 (only readiness distinguishes).
2. Check the managed Postgres status, reachability from the app host, and
   connection count vs the per-instance pool (`max:10`) × instances.
3. Restart instances (pool reconnects). Do not send traffic to an unready
   instance.
4. If a just-applied migration errored, follow DEPLOYMENT.md §3.3 to revert.
5. After recovery, run the post-deployment smoke test (§9).

---

## 7. Auth rate-limit / lockout spike

- Confirm the config matches expected traffic (`AUTH_RATE_MAX`, window).
- Check whether a single client IP is dominating (rate limits are per-instance
  in-memory; see OPERATIONS scaling assumptions).
- Lockout windows are configurable (`AUTH_LOCKOUT_*`); no on-call unlock needed
  beyond waiting for the window (or flushing if a legitimate account is locked).

---

## 8. Incident-response basics
- **Triage tags:** `status`, `severity`, `area (bank/db/auth/ai/ui)`.
- **Cut a link line / incident doc** with a timeline: detected → confirmed →
  mitigated → resolved → evidence.
- **Rules of engagement:** never mutate data or grant credit during an incident
  without a runbook; prefer idempotent fixes; keep a clean timeline for the
  postmortem.
- **Post-incident:** document in this runbook; add a regression test and/or an
  alert if one was missing.

---

## 9. Post-deployment smoke test

Run after **every** deployment (see DEPLOYMENT.md §9):

```bash
curl -sf http://127.0.0.1:3000/api/health  # 200 {"status":"ok"}
curl -sf http://127.0.0.1:3000/api/ready   # 200 {"status":"ready"}
curl -s -o /dev/null -w '%{http_code}\n' https://topflowng.com/.env  # 404
# then one end-to-end login + wallet-balance read; watch `/error` logs
```

Watch logs for `level:error` and Sentry for 15 min after rollout.

---

## 10. Post-mortem template

- **Summary** · **Impact** (users/money/uptime) · **Timeline**
- **Root cause** · **Contributing factors** · **Actions** (with owners).
- **Prevention:** code/tests/alerts/docs changes that close the gap.

---

## 11. Rollback procedure

1. Remove instances from rotation (scale to 0 / remove from LB, keep the DB).
2. Redeploy the previous known-good release / image tag.
3. Confirm `/api/ready` returns 200 and the smoke test passes.
4. Restore traffic gradually.
5. If rollback follows a broken **migration**, revert the data change per
   **DEPLOYMENT.md §3.3** (migrations are forward-only, transactional).

---

This phase deliberately adds **no** automatic production deployment; promotion
is a manual, human-reviewed step (CI/CD stays separated from deploy).