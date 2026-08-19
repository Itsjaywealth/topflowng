# TopFlowNG — Multi-Provider Architecture

Status: **Readiness blueprint — VTPass is the only production-integrated provider.**

This document defines how TopFlowNG is architected to support multiple upstream
digital-product providers without prematurely enabling an unapproved provider.
Nothing here is active in production beyond the existing VTPass integration.

## 1. Current provider (VTPass)

- **Role:** the established Nigerian VTU/bills provider.
- **Capabilities:** Airtime (NG), Data (NG), Electricity (NG), Cable TV (NG), Education (NG / WAEC).
- **Status:** `INTEGRATED` — production-certified for the Nigerian catalog.
- All existing purchase, wallet, ledger, history, receipt, notification and
  reconciliation flows are VTPass-backed and remain the priority.

## 2. Intended future providers

| Provider | Intended capabilities | Status |
|---|---|---|
| Bitrefill | Gift cards, eSIMs, international refills | `BLOCKED_EXTERNAL` — partnership approval pending; no credentials |
| DT One | International airtime/data, eSIMs, gift cards, digital vouchers | `BLOCKED_EXTERNAL` — onboarding/credentials not yet obtained |
| Reloadly | (evaluated) | Blocked by a legitimate country restriction on registration; must NOT be bypassed (no VPN / false jurisdiction) |

Future providers are NOT customer-enabled until: approved → credentialed →
sandbox-certified → financially/security-certified → production-certified.

## 3. Provider abstraction & routing

- `providers/index.js` holds the provider registry. Today it contains only
  VTPass. A second adapter can be added behind the same interface.
- Routing is **fixed/explicit**, never browser-selected and never
  cheapest-provider auto-routing:
  `customer product → internal product → server router → approved provider → provider product`.
- The browser cannot choose a provider, provider product ID, provider cost, or
  customer price. The server is authoritative.
- **Automatic failover is OFF.** A provider request with an UNKNOWN outcome is
  never re-sent to a second provider. Flow: UNKNOWN → requery/status → reconcile
  → only then decide next action.

## 4. Capability registry & feature flags

`config.providers` describes each provider's status and capabilities. All
customer-facing international categories are gated behind `config.features`
flags that default to **OFF**:

- `giftCards`, `esims`, `internationalAirtime`, `internationalData`,
  `digitalVouchers`.

No unfinished category is shown to customers. Env overrides:
`GIFT_CARDS_ENABLED`, `ESIMS_ENABLED`, etc. (all default `false`).

## 5. Catalogue & pricing authority

- `services/pricing.js` is the server-side source of truth for the Nigerian
  catalog; the browser never sets price.
- A future provider catalogue must persist per product:
  TopFlowNG product ID, provider, provider product ID, category, brand, country,
  currency, provider cost where known, customer price, availability,
  last-verified, provider status, customer-enabled status.
- Never delete a historical product because a provider temporarily removes it;
  use inactive/archived state.
- Catalogue freshness must be tracked (`last fetched`, `last verified`, stale
  state) so stale prices are never advertised as current.

## 6. Financial authority & FX

- Customer payments remain in the **TopFlowNG wallet (NGN)** and are separate
  from **upstream provider settlement balances** (Brandverse Ventures treasury).
- If a provider accepts crypto funding, that is provider treasury only — it does
  NOT turn customer wallets into crypto wallets. No customer crypto deposits,
  withdrawals, exchange, or custody.
- For future foreign-currency products: `provider cost × verified FX +
  configured commercial rule = customer NGN price`. Until a verified FX source
  exists, foreign-currency live purchases remain disabled.
- Do not invent exchange rates or select a commercial FX buffer for the owner.

## 7. Price snapshots & margin protection

- Future international orders persist: provider, provider product, provider
  currency, provider cost, FX rate, FX source, FX timestamp, customer price,
  fees, markup rule, transaction timestamp.
- Server-side negative-margin protection: if customer revenue < verified direct
  cost, block the purchase unless an explicit approved subsidy rule exists.
- Owner markup/fee values are configurable, never auto-chosen.

## 8. Reconciliation & idempotency

- Reconciliation must detect: provider success + TopFlowNG pending, provider
  failure + unreversed debit, wallet debit + missing order, order + missing
  ledger, duplicate ledger effect, orphan provider reference.
- Idempotency guarantee preserved: one customer confirmation → one intended
  wallet debit → one intended provider purchase. UNKNOWN is never auto-retried.

## 9. Integration handoffs

### Bitrefill (when Brandverse Ventures is approved)
Receive credentials securely → configure Railway secrets → authenticate →
sandbox/test → sync catalogue → select initial products → configure FX →
configure commercial pricing → financial tests → security tests → controlled
live certification → enable feature flag.

### DT One
Equivalent checklist. Requires sales approval, contract, credentials, funding,
and an owner commercial decision.

## 10. Stop conditions

- Do not spend money, fabricate credentials, bypass provider country
  restrictions, or expose unfinished products.
- Do not create customer crypto balances.
- Stop autonomous work when the only remaining requirements need provider
  approval, credentials, commercial decisions, or real-money authorization.
