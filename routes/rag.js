'use strict';

/**
 * TopFlowNG — RAG-safe, customer-scoped support data API.
 *
 * Every route requires the customer's own JWT (authMiddleware) and returns
 * ONLY that customer's data. Responses are deliberately narrow so a retrieval
 * layer (RAG) can ground support answers without ever touching:
 *   - VTPass credentials / payment secrets / transaction PINs
 *   - electricity tokens or exam PIN values (booleans only)
 *   - another customer's data
 *
 * Transaction truth lives here (live backend data); the RAG layer must never
 * invent status, pricing, provider availability or balances.
 */

const express = require('express');
const db = require('../database');
const { authMiddleware } = require('../middleware/auth');
const { sendError } = require('../lib/errors');
const { productFor } = require('../services/vtpass');

const router = express.Router();
router.use(authMiddleware);

function safeTxn(t) {
  return {
    reference: t.reference,
    service_type: t.service_type,
    amount: Number(t.amount),
    description: t.description,
    status: t.status,
    receipt_available: t.status === 'completed',
    has_token: Boolean(t.has_provider_reference) && /electricity|exam/i.test(t.service_type || ''),
    has_provider_reference: Boolean(t.has_provider_reference),
    created_at: t.created_at,
    updated_at: t.updated_at,
  };
}

// Current transaction status / recent transactions for the signed-in customer.
router.get('/transactions', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);
    const rows = await db.getRagTransactions(req.user.id, {
      limit,
      offset: Math.max(parseInt(req.query.offset) || 0, 0),
      status: ['submitted', 'pending', 'completed', 'failed'].includes(req.query.status) ? req.query.status : null,
      serviceType: req.query.service ? String(req.query.service).slice(0, 40) : null,
    });
    res.json({ ok: true, count: rows.length, transactions: rows.map(safeTxn) });
  } catch {
    sendError(res, 500, 'Failed to load transactions');
  }
});

router.get('/transactions/:reference', async (req, res) => {
  try {
    const row = await db.getRagTransactionByReference(req.user.id, String(req.params.reference));
    if (!row) return sendError(res, 404, 'Transaction not found');
    res.json({ ok: true, transaction: safeTxn(row), reconcile_attempts: row.reconcile_attempts ?? null });
  } catch {
    sendError(res, 500, 'Failed to load transaction');
  }
});

// Supported services + live catalogue pricing + provider availability.
// All figures come from the server-side catalogue — RAG must quote these,
// never invent its own.
router.get('/services', async (req, res) => {
  try {
    const services = [
      { id: 'airtime', name: 'Airtime', providers: ['MTN', 'Glo', 'Airtel', 'T2'], active: true },
      { id: 'data', name: 'Data', providers: ['MTN', 'Glo', 'Airtel', '9mobile'], active: true },
      { id: 'electricity', name: 'Electricity', providers: ['IKEDC', 'EKEDC', 'AEDC', 'PHEDC', 'KEDC', 'IBEDC', 'JED', 'KAEDCO', 'EEDC', 'BEDC', 'APLE', 'YEDC'], active: true },
      { id: 'cable', name: 'Cable TV', providers: ['DSTV', 'GOTV', 'STARTIMES'], active: true },
      { id: 'exam', name: 'Exam PINs', providers: ['WAEC', 'JAMB', 'NECO', 'NABTEB'], active: true },
    ];
    let dataPlans = {};
    try {
      const { DATA_PLANS } = require('../services/pricing');
      dataPlans = DATA_PLANS;
    } catch { /* catalogue unavailable — omit rather than guess */ }
    res.json({ ok: true, services, data_plans: dataPlans });
  } catch {
    sendError(res, 500, 'Failed to load services');
  }
});

// Curated FAQ/help content. Static copy owned by the backend — RAG can quote
// verbatim but never extend it with generated policy claims.
router.get('/faq', (req, res) => {
  res.json({
    ok: true,
    faqs: [
      {
        q: 'How long does an airtime or data purchase take?',
        a: 'Most airtime and data purchases complete instantly. If the provider is slow, your order shows as pending and resolves automatically — you are only debited when it succeeds.',
      },
      {
        q: 'What does a pending order mean?',
        a: 'The provider accepted your order but has not confirmed delivery yet. Your wallet is not debited while an order is pending. We re-check the order automatically and email you the outcome.',
      },
      {
        q: 'What happens if a purchase fails?',
        a: 'Failed orders are never charged. If a debit did occur before a failure, the wallet is refunded automatically during reconciliation.',
      },
      {
        q: 'Where is my electricity token?',
        a: 'Tokens appear on your purchase receipt immediately after a successful payment and are also sent to your email. Open the transaction in Activity and tap the receipt.',
      },
      {
        q: 'How do I get a refund?',
        a: 'You do not need to request one for failed orders — refunds are automatic. For anything else, contact support from the app with your transaction reference.',
      },
      {
        q: 'How do I fund my wallet?',
        a: 'Open Wallet and follow the funding flow. Funding is processed by our secure payment provider.',
      },
      {
        q: 'Is my transaction PIN safe?',
        a: 'Your PIN is stored hashed and is never displayed, emailed, or asked for by support. TopFlowNG will never ask for your password or PIN.',
      },
    ],
  });
});

module.exports = router;
