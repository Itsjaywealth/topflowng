# TopFlowNG

> Nigeria's instant VTU platform — airtime, data, electricity, cable TV, and exam pins, paid for securely per order.

[![Status](https://img.shields.io/badge/status-active-success)]()
[![Node](https://img.shields.io/badge/node-22-green)]()
[![Railway](https://img.shields.io/badge/deployed-Railway-7C3AED)]()

## Overview

TopFlowNG provides instant virtual top-up services across Nigeria. Users can purchase airtime, data bundles, pay electricity bills, subscribe to cable TV, and buy exam pins — all from a single platform, paying securely for each order.

### Features

- **Airtime & Data** — Instant top-up for all major Nigerian networks (MTN, Glo, Airtel, 9mobile)
- **Bill Payments** — Electricity (IKEDC, AEDC, Eko, Kano, Port Harcourt, Jos) and cable TV (DSTV, GOtv, Startimes)
- **Exam Pins** — WAEC result checker PINs (genuinely active provider products only)
- **Admin Dashboard** — User management, transaction history, financial reconciliation
- **Direct Per-Order Payment** — customers pay securely at checkout; no stored-value wallet
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
