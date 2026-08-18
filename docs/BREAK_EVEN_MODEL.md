# TopFlowNG — Break-Even & Business Model

## Current architecture
TopFlowNG is a wallet-first VTU (airtime, data, electricity, cable, education) platform. Revenue comes from the **margin between what customers pay and what VTPass charges** (service markup).

## Model inputs (ALL owner-decided — none invented here)
- `markup%` — per-product margin (airtime, data, electricity, cable).
- `serviceFee` — optional flat fee.
- `referralReward` — credit given per successful referral top-up.
- Fixed costs — Railway web + Postgres (and any paid infra the owner chooses).

## Break-even sketch
Break-even is reached when cumulative gross margin ≥ cumulative fixed + variable costs.

- Gross margin per transaction = (markup applied) − (payment processing fees).
- Fixed monthly costs = hosting + any paid infra.
- Break-even transactions/month = monthly fixed costs ÷ average gross margin per transaction.

> Exact figures require owner decisions on markup and infra spend. The platform
> records real ledger data (credits, completed debits) in `/api/admin/stats` so
> the owner can compute actual gross margin once live transactions begin.

## Safety
- No markup/fee/reward values are hardcoded or invented.
- Architecture supports adding markup/fees safely once values are provided.

## Owner decisions required
- markup% per service
- service fee (if any)
- referral reward value
- paid infrastructure budget (backups/PITR etc.)

Until these are set, the platform runs at zero margin by design.
