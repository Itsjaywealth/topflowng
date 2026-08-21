'use strict';

/**
 * TopFlowNG — Owner / super-admin surface.
 *
 * Guarded by ownerMiddleware (JWT + DB is_admin + OWNER_EMAILS allow-list).
 * Read-only operational overview: system health, integration status and the
 * automation audit tail. No customer data leaves these endpoints beyond what
 * admin surfaces already expose.
 */

const express = require('express');
const db = require('../database');
const config = require('../config');
const { ownerMiddleware } = require('../middleware/auth');
const { sendError } = require('../lib/errors');

const router = express.Router();
router.use(ownerMiddleware);

router.get('/overview', async (req, res) => {
  try {
    const [stats, dbPing] = await Promise.all([
      db.getAdminStats().catch((e) => ({ error: e.message })),
      db.ping().then(() => 'ok').catch((e) => `down: ${e.message}`),
    ]);

    let provider = null;
    try {
      const { healthCheck } = require('../services/vtpass');
      provider = await healthCheck();
    } catch (e) {
      provider = { status: 'UNKNOWN', error: e.message };
    }

    // Live provider float — the number that decides whether orders can fulfil.
    let providerWallet = null;
    try {
      const { getWalletBalance } = require('../services/vtpass');
      providerWallet = { balanceNgn: Number((await getWalletBalance()).toFixed(2)) };
    } catch (e) {
      providerWallet = { error: e.message };
    }

    let redis = 'not configured';
    try {
      const cache = require('../lib/cache');
      redis = cache.get ? 'ok' : 'ok';
    } catch { /* cache optional */ }

    const { rows: eventCounts } = await db.pool.query(
      `SELECT type, count(*)::int AS n FROM automation_events
       WHERE created_at > NOW() - INTERVAL '24 hours' GROUP BY type ORDER BY n DESC LIMIT 10`
    ).catch(() => ({ rows: [] }));

    const { rows: pendingDeliveries } = await db.pool.query(
      `SELECT status, count(*)::int AS n FROM webhook_deliveries GROUP BY status`
    ).catch(() => ({ rows: [] }));

    // Wallet-product retirement: stored balances held for reconciliation.
    // Read-only — this surface never mutates balances.
    const { rows: balanceHolders } = await db.pool.query(
      `SELECT count(*)::int AS accounts, coalesce(sum(wallet),0)::float AS total
       FROM users WHERE wallet > 0`
    ).catch(() => ({ rows: [{ accounts: 0, total: 0 }] }));
    const { rows: flaggedRecent } = await db.pool.query(
      `SELECT count(*)::int AS n FROM audit_log
       WHERE action = 'wallet.balance.reconciliation_required'
         AND created_at > NOW() - INTERVAL '7 days'`
    ).catch(() => ({ rows: [{ n: 0 }] }));

    res.json({
      ok: true,
      owner: req.user.email,
      system: {
        env: config.env,
        database: dbPing,
        redis,
        paymentMode: config.paymentMode,
        provider: provider ? { status: provider.status || 'unknown' } : null,
      },
      integrations: {
        vtpass: provider ? provider.status || 'unknown' : 'unknown',
        vtpassWallet: providerWallet,
        internalApi: Boolean(config.internalApiKey),
        emailConfigured: Boolean(config.resend.apiKey || process.env.SMTP_HOST),
        bizflowUrl: config.bizflow.apiUrl || null,
        ownerEmails: config.ownerEmails,
      },
      automation: {
        eventsLast24h: eventCounts,
        webhookDeliveries: pendingDeliveries,
      },
      catalogueSync: (() => {
        try { return require('../services/catalog-sync').getLastReport(); } catch { return null; }
      })(),
      reconciliation: {
        storedBalanceAccounts: balanceHolders[0]?.accounts || 0,
        storedBalanceTotalNgn: balanceHolders[0]?.total || 0,
        flaggedLast7d: flaggedRecent[0]?.n || 0,
        note: 'Non-zero stored balances are flagged for reconciliation/refund/migration — never erased.',
      },
      stats,
      generatedAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, 500, 'Failed to build owner overview');
  }
});

module.exports = router;
