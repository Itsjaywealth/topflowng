# TopFlowNG

> Nigeria's leading VTU platform — airtime, data, electricity, cable TV, betting wallets, exam pins, and recharge pins.

[![Status](https://img.shields.io/badge/status-active-success)]()
[![Node](https://img.shields.io/badge/node-22-green)]()
[![Railway](https://img.shields.io/badge/deployed-Railway-7C3AED)]()

## Overview

TopFlowNG provides instant virtual top-up services across Nigeria. Users can purchase airtime, data bundles, pay electricity bills, subscribe to cable TV, fund betting wallets, and buy exam/recharge pins — all from a single platform.

### Features

- **Airtime & Data** — Instant top-up for all major Nigerian networks (MTN, Glo, Airtel, 9mobile)
- **Bill Payments** — Electricity (IKEDC, AEDC, Eko, Kano, Port Harcourt, Jos) and cable TV (DSTV, GOtv, Startimes)
- **Betting Wallets** — Fund betting accounts (Bet9ja, SportyBet, 1xBet, MerryBet)
- **Exam Pins** — WAEC, NECO, JAMB registration pins
- **Admin Dashboard** — User management, transaction history, financial reconciliation
- **Wallet System** — Multi-currency wallet with debit/credit tracking
- **Automated Scheduling** — Cron-based recurring purchase execution

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Node.js](https://nodejs.org/) |
| Framework | Custom Express-like server |
| Database | PostgreSQL |
| Auth | JWT-based (admin + user tokens) |
| Provider | ClubKonnect API |
| Deployment | [Railway](https://railway.app/) |

## Getting Started

```bash
git clone https://github.com/Itsjaywealth/topflowng.git
cd topflowng
npm install
cp .env.example .env
# Configure your environment variables
node server.js
```

## License

MIT License — see [LICENSE](LICENSE)

---

Built by [Brandverse Ventures](https://brandverseventures.com)
