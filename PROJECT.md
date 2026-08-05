# TopFlowNG — Project Overview

**Name:** TopFlowNG
**Version:** 1.0.0
**Tagline:** "Nigeria's Smartest Digital Services Platform"
**Live domain:** https://topflowng.com
**Hosting:** Railway (Node.js web process, PostgreSQL database)
**Repository:** https://github.com/Itsjaywealth/topflow (branch: `main`)

---

## What TopFlow NG is

TopFlowNG is a Nigerian digital services platform that lets customers buy everyday
utility and digital products — airtime, mobile data, electricity, cable TV, exam PINs,
and recharge cards — through a prepaid wallet funded by card or bank payments
via Paystack.

It is a single-repository, single-page application stack:

- **Backend:** Express 4 REST API (PostgreSQL via `pg`, JWT auth, Helmet, rate limiting)
- **Customer app:** `topflowng.html` — mobile-first PWA (offline shell via `sw.js`,
  installable via `manifest.json`)
- **Admin console:** `admin.html` — stats, transactions, users, and VTU order reconciliation
- **B2B suite:** `bizflow.html` — a standalone invoice/CRM/payroll SPA for Nigerian SMEs
  (currently persists to `localStorage` only)

Purchases are fulfilled through **Clubkonnect's reseller API** (the underlying network
provider), with every order tracked in the database so no customer is debited until the
provider confirms delivery.

---

## Business goals

- **Sell digital utility services at scale** with a low-friction prepaid wallet instead of
  pay-per-transaction card charges.
- **Earn reseller margin** on every Clubkonnect transaction (recharge PINs and exam PINs
  are also resold at a markup).
- **Drive organic growth through referrals** — each referred user earns the referrer a
  ₦100 bonus on their first funded top-up.
- **Keep the operation cost-efficient** — a single Node.js process on Railway with managed
  PostgreSQL, avoiding per-transaction fees where possible.
- **Protect revenue through reconciliation** — pending provider orders are never auto-debited
  and are resolved manually by admins against Clubkonnect's Query API.

---

## Target users

| Segment | Who they are | How they use TopFlowNG |
|---|---|---|
| **Consumer customers** | Nigerians who routinely buy airtime, data, and pay for electricity/TV | Fund a wallet once, then buy services in seconds with a transaction PIN |
| **Resellers / bulk buyers** | People who buy recharge PINs and exam PINs to resell | Bulk-purchase PINs (up to 5 per order) at a discount from walk-in prices |
| **SME operators (BizFlow NG)** | Nigerian small businesses managing invoicing, clients, staff, and payroll | Use the standalone B2B suite for billing and payroll management |
| **Admins** | The TopFlowNG operator | Monitor revenue, review transactions/users, and reconcile stuck VTU orders |

---

## Current modules

### 1. Customer app (`topflowng.html`)
- Auth: register, login, password reset (email link), change password
- Prepaid wallet: balance, top-up via Paystack, transaction history with filters
- Service purchases (6 tiles):
  1. **Airtime** — MTN, GLO, 9mobile, Etisalat/Airtel
  2. **Data bundles** — plan-code based, all four networks
  3. **Electricity** — DisCo + meter type/number, returns token on success
  4. **Cable TV** — DStv/GOtv/StarTimes-style plan codes on smart card number
  5. **Exam PINs** — WAEC (₦3,900), NECO (₦1,000), NABTEB (₦1,000), JAMB (₦4,700); qty 1–5
  6. **Recharge PINs** — all networks, denominations ≥ ₦100, qty 1–5
- Transaction PIN gate (4–6 digit) on all purchases
- Beneficiaries: save/reuse/delete per service
- Referral: shareable code, referral count + earnings
- Analytics: per-service spend breakdown
- PWA: installable, offline shell, network-first API caching

### 2. Admin console (`admin.html`)
- Admin login (JWT, `is_admin` flag)
- Dashboard stats: total users, transactions, credited vs debited totals
- All transactions (tabs: all / top-ups / debits) with user details
- All users (search + admin flag view)
- **VTU order reconciliation** — re-queries Clubkonnect for any pending order and
  settles it to completed/failed without double-debiting

### 3. BizFlow NG (`bizflow.html`) — standalone B2B SPA
- Dashboard: revenue stats, chart, recent invoices
- Invoices: line items, VAT calculation, mark paid, status filters
- CRM / Clients: client records, per-client billing, invoice shortcuts
- Payroll: gross/net calculation with NHF + pension deductions
- HR / Staff: directory, employment types, salary tracking
- Data persisted in `localStorage` only (no backend yet)

### 4. Backend API (`server.js` + `database.js`)
- REST API surface: `/api/auth/*`, `/api/user/*`, `/api/wallet/*`, `/api/paystack/*`,
  `/api/vtu/*`, `/api/admin/*`, `/api/beneficiaries`, `/api/referral`, `/api/analytics/*`
- PostgreSQL schema: `users`, `transactions`, `password_resets`, `paystack_refs`,
  `vtu_orders`, `beneficiaries`
- Paystack webhook with HMAC signature verification + idempotent crediting
- Clubkonnect response normalisation (success / pending / failed) and order lifecycle
  (`submitted → pending → completed | failed`)

---

## Future roadmap

Phased priorities based on the current state of the codebase:

1. **Phase 1 — Security hardening**
   - Add positive/finite amount validation to all VTU routes
   - Move served assets into a `public/` directory; stop serving the repo root
   - Escape rendered transaction HTML; fix the duplicated `</head><body>` block
   - Remove committed backup files (`.backup-*`, `.bak`) and dead `auth.js`
2. **Phase 2 — Data integrity & operations**
   - Server-side pricing tables (data/cable plans) instead of client-supplied amounts
   - Scheduled (cron) reconciliation of stuck pending orders
   - Admin user creation path; audit logging
3. **Phase 3 — Growth & retention**
   - More exam bodies / plan catalogues; multi-wallet or savings features
   - Push notifications for order status
   - Email receipts on every completed order (already scaffolded via Resend)
4. **Phase 4 — BizFlow NG backend**
   - Replace `localStorage` with authenticated server-side storage
   - Multi-tenant isolation, invoicing history, payroll records
5. **Phase 5 — Platform scale**
   - Automated test suite (unit + integration)
   - CI/CD pipeline, linting/type checks, structured logging

---

## Completed features

- Wallet top-up via Paystack with webhook + callback verification and idempotency
- 6 purchase services (airtime, data, electricity, cable, exam PINs, recharge PINs)
- Transaction PIN enforcement on all purchases
- Beneficiaries (save/load/delete per service)
- Referral codes with ₦100 bonus on first funded top-up
- Per-service spend analytics
- Password reset via email (Resend)
- Admin console: stats, transactions, users, VTU reconciliation
- Provider response normalisation and pending-order reconciliation flow
- PWA: manifest, icons, service worker
- Visual identity: Flow Green (#00B67A) primary, dark Ink sidebar, Plus Jakarta Sans font
- BizFlow NG B2B suite (invoices, clients, payroll, staff — localStorage-backed)

---

## Planned features

- Server-side plan/pricing catalogues (remove client-supplied pricing)
- Automated reconciliation job for pending VTU orders
- In-app admin user creation and role management
- Automated tests and CI
- BizFlow NG server-side persistence (multi-user)
- Push/status notifications and richer email receipts
- Expanded product catalogue (more exam bodies, TV plans, data plans)

---

## How to run

```bash
npm install
cp .env.example .env      # fill in real keys
npm run dev               # nodemon (development)
npm start                 # node server.js (production)
```

See `.env.example` for the full environment variable reference and `DEPLOY.md` for the
deployment guide.
