# TopFlowNG — Scale Model

## Growth trajectory
- **1K users**: current single-service architecture is validated and ready.
- **10K users**: add composite DB indexes, raise connection pool, consider PgBouncer, add per-provider throttling. See 100K_SCALE_ARCHITECTURE.md.
- **100K users**: managed PITR, read replicas, distributed job execution, CDN caching, provider queue.

## Financial scale guardrails
- Settlement must remain exactly-once at every scale (already enforced by row locks + idempotency).
- Wallet must never go negative (guard present).
- Reconciliation must remain "In balance" — monitored daily (OPERATIONS_RUNBOOK).

## Operational scale
- Ops watchdog (alerting module) provides cooldown-gated alerts without paid services.
- Operations center answers "is TopFlowNG healthy" at a glance.

## Dependency on owner decisions
Scale-up of real transactions requires:
- markup/fee decisions (BREAK_EVEN_MODEL)
- controlled live certification (owner authorization + operator-owned targets)
- paid infrastructure for backups/PITR at scale (not purchased)

## Ready checkpoints
- 1K SCALE READY = YES (current build validated).
- Real-money launch = gated on certification + owner decisions.
