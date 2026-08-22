# IMPLEMENTED — BizFlowNG ⇄ TopFlowNG business ordering contract

Supersedes `bizflowng/docs/CROSS_PROJECT_TASK_TOPFLOWNG.md` (that spec's paths
differ from what shipped; this is the live contract as of commit 4103719+).

## Base URL
`https://topflowng.com/api/integrations/topflowng`

## Auth (both directions use the SAME per-business key)
- Header `x-bizflow-key: <integration key>` (the key generated in
  BizFlowNG Settings → Account, linked by the user in TopFlowNG Account → Integrations)
- `x-topflow-timestamp: <unix>` and `x-topflow-signature: v1=<hex(HMAC_SHA256(key, "<ts>.<rawBody>"))>`
- ±5 min replay window. GET signs the empty string body.

## GET /services?business_id=<id>
Read-only catalogue: categories airtime/data/electricity/cable/exam-pin,
providers, variations with CUSTOMER prices (`customerPrice`), required fields.
Never exposes provider costs or credentials.

## POST /order-intents
Body: `{ business_id, serviceType: "airtime"|"data"|"electricity"|"cable"|"exam-pin",
details:{...}, idempotency_key }`.
- Price is ALWAYS recomputed server-side from the catalogue (client amounts for
  plan-based products are validated, never trusted).
- Response 201 `{ ok:true, intent:{ id, status:"pending", amount, ... } }`;
  duplicate idempotency_key → 200 `{ duplicate:true }`; unknown plan → 400.
- NOTHING is purchased at this point.

## User confirmation (TopFlowNG side)
The linked user approves in TopFlowNG → Account → Business orders → Approve.
Approving creates a direct order + secure checkout URL. On payment success the
existing fulfilment pipeline runs (VTPass), then normal expense sync can push
the eligible purchase back to BizFlowNG (same signed expense receiver).

## Intent state
`GET /order-intents/:id` → `{ intent:{ status:"pending"|"confirmed"|"declined", order_request_id } }`

## BizFlowNG TODO (their side)
Point the service-orders caller at THESE paths/scheme (or ask TopFlowNG to add
a compat alias). The previously documented `/api/integrations/bizflow/orders`
with TOPFLOWNG_SYNC_SECRET shared-secret headers was NOT implemented.

## UPDATE — shared-secret scheme now ALSO accepted (compat with the original spec)
`TOPFLOWNG_SYNC_SECRET` is set on BOTH services (same value). TopFlowNG
additionally accepts, at `/api/integrations/topflowng/*`, the original
BizFlowNG scheme:
- header `x-topflow-signature: t=<unix>,v1=<hex(HMAC_SHA256(secret,"<ts>.<rawBody>"))>`
- `POST /api/integrations/topflowng/orders` with body
  `{ source:"bizflowng", reference, business_id, service_type, amount,
     recipient?, note?, details? }`
  → responds `{ ok:true, status:"pending", topflow_ref, amount_charged }`
  (status becomes final after the linked user confirms + pays; plan-based
  products are always re-priced server-side — client `amount` is a hint).
Alias base: `/api/integrations/bizflow/*` also mounts the same routes.
