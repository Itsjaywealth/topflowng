# TopFlowNG — Deployment Guide
## Domain: topflowng.com (Hostinger) → Railway (Node.js host)

---

## Overview

| What | Where |
|------|-------|
| Node.js app (server.js) | Railway (free tier, HTTPS included) |
| Domain (topflowng.com) | Hostinger (you already own this) |
| Database (topflowng.db) | On Railway's persistent disk |
| HTTPS/SSL | Railway provides this automatically |

Railway is the simplest path: push your code, it runs. HTTPS is automatic — no Nginx, no Certbot.

---

## STEP 1 — Prepare your code for deployment

Make sure these files exist in your project folder:
```
topflowng/
  server.js
  auth.js
  database.js
  topflowng.html
  package.json
  .env.example
  .gitignore        ← create this
```

Create `.gitignore`:
```
node_modules/
.env
topflowng.db
*.db-shm
*.db-wal
```

---

## STEP 2 — Push to GitHub

1. Go to https://github.com/new → create a **private** repo called `topflowng`
2. In your project folder, run:

```bash
git init
git add .
git commit -m "Initial TopFlowNG commit"
git remote add origin https://github.com/YOUR_USERNAME/topflowng.git
git push -u origin main
```

---

## STEP 3 — Deploy on Railway

1. Go to https://railway.app → Sign up with GitHub
2. Click **New Project → Deploy from GitHub repo**
3. Select your `topflowng` repo → Railway auto-detects Node.js
4. Go to your project → **Variables** tab → add these:

```
PORT                    = 3000
NODE_ENV                = production
APP_URL                 = https://topflowng.com

CLUBKONNECT_USER_ID     = (your Clubkonnect phone number)
CLUBKONNECT_API_KEY     = (your Clubkonnect API key)
CLUBKONNECT_BASE_URL    = https://www.clubkonnect.com

PAYSTACK_SECRET_KEY     = sk_live_xxxxxxxxxxxxxxxxxxxxxx
PAYSTACK_PUBLIC_KEY     = pk_live_xxxxxxxxxxxxxxxxxxxxxx
PAYSTACK_WEBHOOK_SECRET = (from Paystack dashboard → Settings → Webhooks)

JWT_SECRET              = (generate a 64-char random string — use: openssl rand -hex 32)
```

5. Click **Deploy** — Railway builds and runs your app
6. After deploy, go to **Settings → Domains** → click **Generate Domain**
   - You'll get something like: `topflowng-production.up.railway.app`
   - Test it works before pointing your real domain

---

## STEP 4 — Add persistent storage for SQLite

By default Railway restarts wipe the filesystem. To keep `topflowng.db`:

1. In your Railway project → **+ New** → **Volume**
2. Mount path: `/app/data`
3. Update `database.js` line 12 to:
```js
const DB_PATH = path.join(process.env.DB_PATH || __dirname, "topflowng.db");
```
4. Add to Railway variables:
```
DB_PATH = /app/data
```

---

## STEP 5 — Point topflowng.com DNS to Railway

In **Hostinger** control panel:
1. Go to **Domains → topflowng.com → DNS / Nameservers → Manage DNS**
2. Delete any existing A or CNAME records for `@` and `www`
3. Add these records:

| Type  | Name | Value                                      | TTL  |
|-------|------|--------------------------------------------|------|
| CNAME | @    | topflowng-production.up.railway.app        | 3600 |
| CNAME | www  | topflowng-production.up.railway.app        | 3600 |

> ⚠️ Some DNS providers don't allow CNAME on `@`. If that's the case, use Railway's IP instead:
> In Railway → Settings → Domains → show the IP address → add as A record.

4. Back in Railway → **Settings → Custom Domains → Add Domain**
   - Enter: `topflowng.com`
   - Enter: `www.topflowng.com`
   - Railway verifies DNS (can take 10–60 minutes) then issues a free SSL cert

---

## STEP 6 — Set Paystack webhook URL

1. Go to https://dashboard.paystack.com/#/settings/developer
2. Under **Webhook URL**, enter:
   ```
   https://topflowng.com/api/paystack/webhook
   ```
3. Copy the **Webhook Secret** → paste into Railway env as `PAYSTACK_WEBHOOK_SECRET`

---

## STEP 7 — Whitelist Railway IP on Clubkonnect

1. Log in to Clubkonnect → Developer's API → IP Whitelist
2. Find your Railway server IP: run `curl ifconfig.me` from a Railway shell, OR
   go to Railway → your service → **Shell** tab and run:
   ```bash
   curl https://ifconfig.me
   ```
3. Paste that IP into Clubkonnect's whitelist
4. Register at Clubkonnect: **https://www.clubkonnect.com/Register.asp**
5. Fund your Clubkonnect reseller wallet (minimum ₦1,000 to start testing)
6. Get your API key: Dashboard → Developer's API → your UserID + APIKey

---

## STEP 8 — Final checklist before going live

- [ ] `NODE_ENV=production` is set in Railway
- [ ] `APP_URL=https://topflowng.com` is set (Paystack callback needs this)
- [ ] Paystack webhook URL is set to `https://topflowng.com/api/paystack/webhook`
- [ ] Clubkonnect IP is whitelisted
- [ ] Clubkonnect wallet is funded
- [ ] Test one airtime purchase end-to-end
- [ ] Test Paystack card payment (use Paystack test card: 4084 0840 8408 4081, CVV 408, exp 0822)
- [ ] Volume mounted so DB persists across restarts
- [ ] `.env` file is NOT committed to git

---

## Estimated cost

| Service | Cost |
|---------|------|
| Railway Hobby plan | $5/month (needed for volumes + persistent DB) |
| topflowng.com domain | Already paid (Hostinger) |
| Clubkonnect | Free to register; pay per transaction (reseller margin) |
| Paystack | 1.5% + ₦100 per card transaction; free for bank transfer |

Railway free tier works for initial testing but has sleep delays. Upgrade to Hobby ($5/mo) for always-on.

---

## Support

- Railway docs: https://docs.railway.app
- Paystack docs: https://paystack.com/docs
- Clubkonnect: https://www.clubkonnect.com/APIDocs.asp (log in first)
- Clubkonnect register: https://www.clubkonnect.com/Register.asp
