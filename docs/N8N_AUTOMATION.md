# TopFlowNG — n8n Automation

Machine-to-machine endpoints that n8n (or any automation tool) can call to
check platform health and surface orders that need a human. All `/api/internal/*`
endpoints are guarded by the `INTERNAL_API_KEY` secret sent as the
`x-internal-key` header.

## Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /api/internal/ops-summary` | Daily stats: users, transactions, success rate, pending/stale/failed orders. |
| `GET /api/internal/pending-orders?limit=N` | Detail of current `pending` VTU orders (request id, service, amount, user, created, reconcile attempts). |

### Auth header

```
x-internal-key: <INTERNAL_API_KEY>
```

## Setup

1. Set `INTERNAL_API_KEY` on the TopFlowNG deployment (Railway → Variables):
   ```bash
   openssl rand -hex 32
   ```
2. Import the workflow `n8n-workflow-topflowng-pending-orders.json` into n8n
   (Workflows → New → ⋯ → Import from File).
3. Configure n8n variables / credentials:
   - `TOPFLOWNG_API_URL` = `https://topflowng.com`
   - `TOPFLOWNG_INTERNAL_KEY` = the `INTERNAL_API_KEY` value
   - `ALERT_RECIPIENT` = the ops mailbox to receive pending-order alerts
     (e.g. `ops@topflowng.com` or `josephegbedi@gmail.com`)
   - The **Email Pending Alert** node uses an existing Gmail OAuth2 credential
     (`gmailOAuth2`). Point it at the Gmail credential already present in the
     n8n instance.
4. Activate the workflow.

## Workflow: Pending Order Alert

`n8n-workflow-topflowng-pending-orders.json` — every 15 minutes:

1. **Schedule trigger** (every 15 min)
2. **Fetch Pending Orders** — `GET /api/internal/pending-orders` with the
   `x-internal-key` header.
3. **Map Pending Orders** — normalise rows; emits zero items when the list is
   empty (the workflow short-circuits and sends nothing).
4. **Has Pending Orders** — true branch only when at least one order exists.
5. **Format Alert Body** — builds one readable alert with order references,
   service, amount, user, and reconcile-attempt count.
6. **Email Pending Alert** — Gmail to `ALERT_RECIPIENT`.

The 15-minute cadence matches the platform's own pending-order sweep, so the
alert only fires for orders that are genuinely stuck and not being reconciled.

## Testing

```bash
curl -sS -H "x-internal-key: $INTERNAL_API_KEY" \
  https://topflowng.com/api/internal/pending-orders
```
Expect `{ "ok": true, "count": N, "orders": [...] }` (count 0 when healthy).