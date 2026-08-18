# TopFlowNG — 100K Scale Architecture (Future Planning)

> Planning only. Do not over-engineer the current build beyond the evidence of
> 1K/10K demand. This document is a roadmap, not today's implementation.

## Current posture (fits 1K–10K users)

- Single Railway web service + managed Postgres.
- Bounded connection pool (`PG_POOL_MAX`, default 15, capped 25).
- Paginated admin + user queries.
- Indexed lookups (users, transactions, vtu_orders, notifications).
- Background sweeper (single instance) reconciles pending orders and runs scheduled jobs.
- Notifications table indexed by `(user_id, created_at)` and unread.

## Blockers to address at 100K

1. **Database**
   - Add indexes for notification queries already present; add composite indexes on `transactions(user_id, created_at DESC)` and `vtu_orders(status, created_at)` if profiling shows scans.
   - Move to a managed Postgres plan with PITR + automated backups (PAID ACTION REQUIRED — not purchased).
   - Consider read replicas for admin/analytics.
2. **Connection pool**
   - Raise `PG_POOL_MAX` and add connection multiplexing (PgBouncer) if the pool becomes the bottleneck.
3. **Sweeper / background jobs**
   - Single-instance sweeper works today; at scale use a distributed lock / queue (e.g. Postgres advisory locks or a job queue) so multiple replicas don't double-process.
   - Back off provider requery with jitter and respect provider concurrency limits.
4. **Provider concurrency**
   - Add a per-provider rate limiter / queue so bursts don't trip VTPass limits.
5. **Caching**
   - Cache static assets via service worker + CDN; never cache authenticated financial API responses.
   - Cache plan catalog (fetchVariations) with short TTL.
6. **Paystack webhook volume**
   - Already idempotent + exactly-once; at scale add a durable event log for audit.
7. **Observability**
   - Add structured log shipping and a metrics endpoint; the alerting module already supports cooldown-gated conditions.

## Scale checkpoints

- **1K users**: current build is ready (validated).
- **10K users**: add the composite indexes, raise pool, and consider PgBouncer; add per-provider throttling.
- **100K users**: managed PITR, read replicas, distributed job execution, CDN asset caching, and a dedicated provider queue.

## Guardrail

Keep migrations forward-only and financial settlement exactly-once at every scale.
