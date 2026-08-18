# TopFlowNG — Growth Audit

## Current state
- Product: airtime, data, electricity (12 DISCOs), cable TV (DStv/GOtv/StarTimes), education (WAEC; JAMB/NECO/NABTEB disabled), recharge cards (disabled).
- Wallet: fund via Paystack (card/transfer/USSD), transaction PIN, receipts, scheduled purchases, beneficiaries, referrals (rewards not yet active).
- Referral program exists in architecture but reward credits are **not currently active** (owner decision needed).

## Growth levers available (require owner decisions — no invented values)
1. **Referral rewards** — set a referral credit amount for first top-up.
2. **Service markup / service fees** — set the margin on airtime/data/bills.
3. **Promotions / discounts** — set promotional pricing or cashback.
4. **Low-balance threshold** — set the auto top-up reminder threshold (currently user-configurable; a default needs owner input).
5. **Ad spend / marketing budget** — not set.

## Content growth (already live)
- Modern fintech-inspired UI with dual palettes (Teal/Emerald) × Light/Dark/System.
- Notification centre, transaction history with filters/detail/receipts, support/FAQ.
- PWA, SEO structured data, responsive 320–1920.

## Suggested funnel improvements (no code needed yet)
- Promote the referral link in the account/dashboard.
- Surface the "Worth knowing" offers.
- Collect waitlist/feedback via support email.

## Owner decisions required (do not guess)
- Markup/service fee percentages
- Referral reward value
- Promotion/discount values
- Low-balance default threshold
- Ad spend budget

These values must be supplied by the owner; the architecture already supports them safely.
