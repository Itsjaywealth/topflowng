# TopFlowNG — Operations Runbook (Daily Checks)

## Daily checklist

Run each check at least once a day (preferably first thing).

### 1. Site health
```bash
curl -sS https://topflowng.com/api/health
curl -sS https://topflowng.com/api/ready
curl -sS https://topflowng.com/api/providers/health
curl -sI https://topflowng.com
curl -sI https://www.topflowng.com
```
Expected: `health` 200, `ready` 200, provider `OPERATIONAL`, root/www 200.

### 2. Database
- `/api/ready` 200 and admin ops → Database = "Ready".

### 3. VTPass provider + balance
- `/api/providers/health` = OPERATIONAL.
- Check VTPass wallet/balance is healthy (above any low-balance threshold). Do not expose credentials.

### 4. Paystack webhook
- Verify the webhook is registered at `https://topflowng.com/api/paystack/webhook`.
- Confirm recent fundings credited exactly once (no double credits in ledger).

### 5. Pending transactions
- Admin ops → Pending orders and Stale pending. Stale > 0 needs review (sweeper should clear most).

### 6. Failed transactions
- Admin ops → Failed today. High failure rate (< 95% success) needs investigation.

### 7. Reconciliation
- Admin `/api/admin/ops` → Ledger balance = "In balance". Investigate any flagged accounts.

### 8. Alerts
- Check the alerting output / active conditions (ops center, structured logs). Resolve any ALERT conditions.

### 9. Deployment health
- Confirm `DEPLOYED COMMIT == GITHUB MAIN` on Railway.
- Confirm GitHub Actions are green on `main`.

### 10. Background jobs
- Verify the sweeper is running (scheduled purchases / auto-recharge process without `expired_claims` growth).
- Confirm pending orders are being reconciled, not accumulating.

## Automation
The ops watchdog (every 60s) raises cooldown-gated ALERT conditions for:
- `vtpass_unreachable` (error)
- `stale_pending_orders` (warn)
- `ledger_out_of_balance` (error)

Conditions clear automatically on recovery. View them via `/api/admin/ops` or the structured logs.
