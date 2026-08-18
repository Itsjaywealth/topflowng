# TopFlowNG — Disaster Recovery

## Scope

Recovery procedures for production incidents affecting `https://topflowng.com`.

## 1. Site outage (all users, site unreachable)

1. Check status: `curl -sI https://topflowng.com` and `/api/health`.
2. Check Railway service status and deployment health (project `fd606d99-5e37-42c2-804e-75382864501c`, service `10b0c2e2-6f66-4278-9836-1b53cb42ecdc`).
3. If the container is down: **Redeploy** the last healthy deployment (see ROLLBACK_RUNBOOK).
4. If Cloudflare is implicated (DNS/edge): verify DNS records and SSL (leave Cloudflare config unchanged unless a defect is proven).
5. Verify `/api/health`, `/api/ready`, `/api/providers/health`, root and www all return 200.

## 2. Database issue

1. Check `/api/ready` and admin `/api/admin/ops` → Database tile.
2. Confirm Railway Postgres is up (project/environment `124d632d-f52f-495f-b543-c81ba9ef2303`).
3. Inspect logs for connection errors. The app uses a bounded pool (`PG_POOL_MAX`, default 15) with a connection timeout.
4. If a migration failed, run the migration runner idempotently; recover per ROLLBACK_RUNBOOK §3.

## 3. Bad deploy

Follow ROLLBACK_RUNBOOK (revert code or redeploy previous Railway deployment).

## 4. VTPass provider outage

1. Check `/api/providers/health`. The watchdog raises `vtpass_unreachable` and the ops center shows the provider tile.
2. Purchases will return clean provider errors (`productErrorResponse`); users are not charged until confirmation.
3. Pending orders are held and reconciled by the sweeper when the provider recovers — no manual credit needed for confirmed orders.

## 5. Paystack outage / webhook failure

1. Webhooks are signature-validated, amount-verified, reference-verified, and duplicate-protected (`paystack_refs` ON CONFLICT DO NOTHING) → single credit.
2. Failed webhook deliveries are retried by the sweeper and surfaced to admin.
3. If a valid payment was not credited, it will be credited exactly once on retry; the ledger guard prevents double credit.

## 6. Cloudflare issue

Only act if there is proven defect. Otherwise leave DNS/SSL/edge alone.

## 7. Financial integrity issue (drift / negative balance)

1. Admin `/api/admin/ops` reports "Out of balance" and `/api/admin/ops` raises `ledger_out_of_balance`.
2. Wallet has a negative-balance guard; credits/debits are exactly-once.
3. Investigate flagged accounts via `/api/admin/reconciliation`. Do not hand-edit balances without a traceable refund/credit transaction.

## 8. Credential compromise

1. Rotate secrets (JWT, Paystack, VTPass, DATABASE_URL) in Railway env.
2. Do not commit or log secrets — the logger redacts sensitive keys.
3. Force sign-out is achieved by rotating the JWT secret.

## Recovery contact

Immediate operator: owner / maintainer via GitHub + Railway (see OPERATIONS_RUNBOOK).
