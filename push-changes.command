#!/bin/bash
# TopFlowNG — push all pending changes to GitHub
# Double-click this file in Finder to run it.
set -e
REPO="$HOME/Documents/New project/topflowng"
cd "$REPO"

echo "=== TopFlowNG: Committing and pushing changes ==="
echo ""

# Remove stale git lock if present
if [ -f .git/index.lock ]; then
  echo "Removing stale .git/index.lock..."
  rm -f .git/index.lock
fi

# Stage everything
git add database.js server.js topflowng.html manifest.json sw.js bizflow.html icons/icon-192.png icons/icon-512.png

echo "Staged files:"
git status --short

git commit -m "feat: BizFlow NG B2B suite + PWA icons + beneficiaries + PIN + 6 services

TopFlowNG:
- New visual identity: Flow Green (#00B67A) primary, dark Ink sidebar, Plus Jakarta Sans font
- 6-tile service grid: Airtime, Data, Electricity, Cable TV, Exam PINs, Recharge Cards
- Exam PINs: WAEC/NECO/NABTEB/JAMB with dynamic pricing (backend + frontend)
- Recharge Cards: all 4 networks, denomination presets (backend + frontend)
- Transaction PIN: set/verify 4-6 digit PIN gate on all purchases
- Beneficiaries: save/load contacts per service, CRUD via /api/beneficiaries
- Referral system: /api/referral with shareable code and earnings stats
- Analytics summary: /api/analytics/summary per-service spend breakdown
- DB migrations: transaction_pin, referral_code columns; beneficiaries table
- PWA: manifest.json + sw.js service worker (offline shell + network-first API)
- PWA icons: icons/icon-192.png and icons/icon-512.png
- Account screen: referral card, spending analytics, PIN setup

BizFlow NG (NEW — bizflow.html):
- Standalone B2B SPA for Nigerian SMEs
- Slate/Cobalt/Lime design system (dark sidebar)
- Dashboard: revenue stats, chart, recent invoices
- Invoices: create with line items, VAT calc, mark paid, filter by status
- CRM/Clients: add clients, track billing per client, invoice shortcuts
- Payroll: gross/net calc with NHF + pension deductions, run payroll flow
- HR/Staff: staff directory, employment types, salary tracking
- All data persisted in localStorage"

echo ""
echo "Pushing to GitHub..."
git push origin main

echo ""
echo "=== Done! Railway will auto-deploy TopFlowNG from this push. ==="
echo "BizFlow NG (bizflow.html) is live in your repo — host separately when ready."
echo ""
echo "Press any key to close..."
read -n1
