# TopFlowNG — Incident Response

## Severity model

| Sev | Definition | Response time | Example |
|-----|-----------|---------------|---------|
| SEV-1 | Service down, financial integrity at risk, or security compromise | Immediate, continuous | Site outage, duplicate debit/credit, credential leak |
| SEV-2 | Major feature degraded but service usable | < 4 hours | Provider outage, webhook backlog, stale pending pile-up |
| SEV-3 | Minor issue, no user impact | < 24 hours | Cosmetic bug, one-off reconciliation review |

## Response playbooks

### Duplicate debit (SEV-1)
1. Freeze new purchases via the product kill switch / by pausing the relevant provider mapping.
2. Check the order ledger for exactly-once debit (completeVtuOrder debits once under row lock).
3. Do not hand-credit without a traceable transaction. Investigate root cause before reversing.
4. Record a refund transaction if a genuine double-debit is proven; confirm wallet never goes negative.

### Duplicate wallet credit (SEV-1)
1. Webhooks are reference-verified + `paystack_refs` ON CONFLICT DO NOTHING → single credit.
2. Verify the payment reference was not credited twice by checking `paystack_refs` and the credit transaction.
3. If a double credit occurred, reverse with a traceable debit and flag the account.

### Lost electricity token (SEV-2)
1. The token is persisted durably in the order's provider response and is recoverable from:
   - user transaction detail (fetch `/api/vtu/orders/:requestId` → `electricityToken`)
   - admin `/api/admin/vtu-orders/:requestId` → `electricityToken`
2. Recover it there; no re-vending required. Do not re-vend a token (risk of double).

### Provider outage (SEV-2)
1. Confirm via `/api/providers/health` and admin ops tile.
2. Pending orders are held; the sweeper reconciles on recovery. Inform users via the operations center / support.

### Database outage (SEV-1)
1. See DISASTER_RECOVERY §2. Confirm `/api/ready`.
2. If migration-related, apply forward-only recovery.

### Site outage (SEV-1)
1. Redeploy last healthy build (ROLLBACK_RUNBOOK §4).

### Webhook outage (SEV-2)
1. Verify webhook is registered at `https://topflowng.com/api/paystack/webhook`.
2. Failed deliveries retried by sweeper; ledger guard prevents double credit on replay.

## Roles
- On-call operator: maintainer (GitHub + Railway access).
- Escalation: for financial integrity issues, stop further purchases until root-caused.

## Post-incident
- Update ops center / runbook with the fix.
- Add a regression test where applicable.
