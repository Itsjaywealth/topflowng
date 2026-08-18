# TopFlowNG — Production Architecture

## Topology
```
Cloudflare (DNS/SSL edge) ──> https://topflowng.com
                                    │
                          Railway Web Service (Node.js)
                          project fd606d99-5e37-42c2-804e-75382864501c
                          service  10b0c2e2-6f66-4278-9836-1b53cb42ecdc
                          env      124d632d-f52f-495f-b543-c81ba9ef2303
                                    │
                          Railway Managed Postgres (DATABASE_URL)
```

## Deployment
- Source of truth: GitHub `main` (`Itsjaywealth/topflowng`).
- GitHub → Railway auto-deploy; `DEPLOYED COMMIT == GITHUB MAIN` when healthy.
- Static assets (topflowng.html, admin.html, manifest, sw.js, assets/) served by the Node app.

## Key subsystems
- **Auth**: JWT + bcrypt; lockout/rate limiting; transaction PIN.
- **Wallet**: PostgreSQL balances; negative-balance guard; Paystack funding (exactly-once via `paystack_refs`).
- **Purchases**: idempotency (request_fingerprint) → VTPass → completeVtuOrder (row-locked single debit).
- **Reconciliation**: background sweeper requeries pending orders; admin manual reconcile; on-demand order status.
- **Notifications**: table + `/api/notifications`; events from wallet credit, purchases, scheduled runs, login.
- **Monitoring**: `/api/admin/ops`, ops watchdog + `lib/alerting.js` (cooldown-gated ALERT conditions).
- **PWA**: manifest, service worker (never caches `/api`), offline fallback.
- **SEO**: structured data, canonical, OpenGraph, robots, sitemap.

## Data safety
- Idempotency + exactly-once debit/credit + reconciliation.
- Token durability (electricity) persisted in order provider response; recoverable by user + admin.
- Backups/PITR: require paid Railway plan — NOT purchased (owner decision).

## Costs & scaling
- See BREAK_EVEN_MODEL, SCALE_MODEL, 100K_SCALE_ARCHITECTURE.
