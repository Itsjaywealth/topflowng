# TopFlowNG — Integrations (n8n · RAG · BizFlowNG)

TopFlowNG is automation-ready: an outbound, signed event bus for n8n, a
customer-scoped RAG-safe data API for support tooling, and an explicit opt-in
pipeline that turns approved business purchases into BizFlowNG expenses.

VTPass remains the only active fulfilment provider. Bitrefill and DT One stay
inactive.

---

## 1. Event bus (n8n)

Every meaningful platform moment is emitted as a signed event. Events are
persisted first (`automation_events`), then delivered at-least-once to each
registered webhook endpoint with retries and backoff:

`1 min → 5 min → 30 min → 2 h → 12 h → dead-letter`

### Event types

| Event | When |
|-------|------|
| `topflow.transaction.created` | VTU order row created (wallet or direct mode) |
| `topflow.transaction.pending` | Order enters `pending` (awaiting provider confirmation) |
| `topflow.transaction.success` | Order completed; wallet debited exactly once |
| `topflow.transaction.failed`  | Order failed; no debit (or refund path) |
| `topflow.transaction.reconciled` | Reconciliation settled a pending order |
| `topflow.receipt.ready` | Receipt data available (includes `has_token` boolean, never the token) |
| `topflow.renewal.due` | Catalogue-derived renewal date inside the reminder window |
| `topflow.customer.dormant` | Customer inactive ≥ `DORMANT_DAYS` (re-emission guarded to 14 days) |
| `topflow.customer.notified` | In-app notification created |
| `topflow.support.escalated` | Chat escalated to a human support ticket |
| `topflow.bizflow.link.verified` | Customer linked + verified their BizFlowNG account |
| `topflow.bizflow.expense.queued` | Customer opted a successful purchase into expense sync |
| `topflow.bizflow.expense.synced` | Expense accepted by BizFlowNG |
| `topflow.test.ping` | Endpoint verification ping |

Payloads are sanitised: keys matching `pin / password / token / secret /
api_key / authorization / credential / otp` are redacted before persistence
and delivery. Electricity tokens and exam PINs never travel in events.

### Webhook contract

Each delivery POSTs JSON with headers:

```
x-topflow-event-id:    <event uuid>          # idempotency key
x-topflow-event-type:  topflow.transaction.success
x-topflow-timestamp:   <unix seconds>
x-topflow-signature:   v1=<hex hmac>
```

Signature = `HMAC_SHA256(endpoint_secret, "<timestamp>.<raw body>")`.
Reject replays by checking the timestamp is recent and recomputing the MAC.

### Setup (n8n side)

```bash
# 1. Register an endpoint (secret is returned once — store it in n8n)
curl -X POST https://topflowng.com/api/internal/webhook-endpoints \
  -H "x-internal-key: $INTERNAL_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"n8n ops","url":"https://<your-n8n>/webhook/topflow","events":["topflow.transaction.success","topflow.renewal.due"]}'

# 2. Verify delivery end-to-end
curl -X POST https://topflowng.com/api/internal/webhook-endpoints/<id>/test \
  -H "x-internal-key: $INTERNAL_API_KEY"
```

### Pull-based alternatives (no public webhook needed)

| Endpoint | Purpose |
|----------|---------|
| `GET /api/internal/events?type=&since=&limit=` | Event log tail |
| `GET /api/internal/renewals/upcoming?days=3` | Renewals due in the window |
| `GET /api/internal/customers/dormant?days=30` | Reactivation candidates |
| `GET /api/internal/bizflow/syncs?status=queued` | Approved expense-sync queue |
| `GET /api/internal/audit?action=&limit=` | Audit log tail |

All guarded by `x-internal-key: $INTERNAL_API_KEY`.

**n8n is read-only by design.** No endpoint here can mutate transaction state,
VTPass order state, balances, ledger entries, refunds or reconciliation
outcomes. Any such action must use the authenticated customer/admin APIs.

---

## 2. RAG-safe support data (customer-scoped)

Base: `/api/rag/*` — requires the customer's own JWT (`Authorization: Bearer`).
Only that customer's rows are ever reachable.

| Endpoint | Returns |
|----------|---------|
| `GET /api/rag/transactions?status=&service=&limit=` | Recent orders: reference, service, amount, status, receipt availability |
| `GET /api/rag/transactions/:reference` | One order (404 for anything not owned by the caller) |
| `GET /api/rag/services` | Supported services, providers, real catalogue data pricing |
| `GET /api/rag/faq` | Curated FAQ copy (quote verbatim; do not extend) |

Never exposed: VTPass credentials, payment secrets, transaction PINs,
electricity token / exam PIN **values** (booleans only), other customers' data.

RAG consumers must treat these responses as the single source of truth for
transaction status, pricing, provider availability and balances — never
generate them.

---

## 3. BizFlowNG expense sync (explicit opt-in)

A customer links their BizFlowNG business once, then pushes individual
**successful** purchases as expense candidates. Personal transactions are
never auto-synced.

| Endpoint | Purpose |
|----------|---------|
| `POST /api/bizflow/link` | Store + verify `{businessId, apiKey, baseUrl?}` — key encrypted (AES-256-GCM), only a fingerprint is ever returned |
| `GET /api/bizflow/link` | Link status |
| `DELETE /api/bizflow/link` | Unlink |
| `POST /api/bizflow/sync` | Opt a successful transaction in: `{reference, category?}` |
| `GET /api/bizflow/syncs` | The customer's sync history |

Guarantees: explicit linking, verified successful transaction, approved
categories only (`electricity, airtime, data, cable, exam-pin, other`),
idempotency via UNIQUE `reference` on both sides, retry with capped backoff,
audit trail, wallet untouched on any failure.

BizFlowNG receives a signed POST at `BIZFLOWNG_SYNC_PATH`
(default `/api/integration/expenses`) with `x-bizflow-key` + TopFlowNG HMAC
headers and `reference` as the dedupe key.

---

## 4. Renewal metadata

`renewal_meta` records plan/provider/validity for data + cable purchases.
`validity_days` is parsed **only** from catalogue plan names (e.g.
`"1GB — 30 days"`). Cable catalogues state no cycle → validity stays NULL and
no renewal date is assumed. A sweep emits `topflow.renewal.due` when a known
date falls inside `RENEWAL_WINDOW_DAYS` (default 3).

---

## 5. Support escalation

`POST /api/support/escalate` `{subject, message?, reference?}` (customer JWT,
rate-limited) creates a ticket, emits `topflow.support.escalated` and notifies
the customer in-app. The chatbot remains the instant-answer layer.

---

## 6. Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `INTERNAL_API_KEY` | — (fail-closed) | Guards `/api/internal/*` |
| `EVENT_TIMEOUT_MS` | 10000 | Webhook/sync HTTP timeout |
| `EVENT_DELIVERY_SWEEP_MS` | 60000 | Delivery retry sweep |
| `DORMANT_DAYS` | 30 | Dormancy threshold |
| `RENEWAL_WINDOW_DAYS` | 3 | Renewal reminder window |
| `BIZFLOWNG_API_URL` | — | Default BizFlowNG instance for links |
| `ENCRYPTION_KEY` | derived from `JWT_SECRET` | AES key for stored link keys |

## 7. Audit

Every automation-relevant action lands in `audit_log` (actor, action, entity,
metadata, ip): endpoint create/delete, delivery outcomes, link/unlink, sync
queue/deliver, escalations. Tail it via `GET /api/internal/audit`.
