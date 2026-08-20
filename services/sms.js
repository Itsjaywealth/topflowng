/**
 * TopFlowNG — SMS service (Termii).
 *
 * Transactional SMS receipts for real product events (purchase outcomes,
 * wallet credits). Delivery is a best-effort side channel: a failure here must
 * never corrupt or block a financial transaction, so every send is fire-and
 * -forget and every error is logged, never thrown to the caller.
 *
 * When `TERMII_API_KEY` is not configured the service is a silent no-op, so
 * the platform degrades gracefully to email + in-app notifications.
 */

'use strict';

const axios = require('axios');

const config = require('../config');
const logger = require('../lib/logger');

function isSmsConfigured() {
  return Boolean(config.sms?.termiiApiKey);
}

// Normalises a Nigerian phone number to the international format Termii expects
// (e.g. "08123456789" / "+2348123456789" → "2348123456789"). Non-Nigerian
// numbers are passed through with the leading "+" stripped.
function normalizePhone(phone) {
  if (!phone) return null;
  let p = String(phone).replace(/[^\d+]/g, '').replace(/^\+/, '');
  if (p.length === 10 && p.startsWith('0')) p = `234${p.slice(1)}`;
  if (p.length === 11 && p.startsWith('0')) p = `234${p.slice(1)}`;
  if (p.length === 13 && p.startsWith('234')) p = `234${p.slice(3)}`;
  return p.length >= 10 ? p : null;
}

async function sendSms(to, message) {
  if (!isSmsConfigured()) {
    logger.info('SMS skipped (Termii not configured)', { to: String(to).slice(0, 6) });
    return { sent: false, reason: 'not-configured' };
  }
  const recipient = normalizePhone(to);
  if (!recipient) {
    logger.warn('SMS skipped: invalid recipient phone', { to: String(to).slice(0, 6) });
    return { sent: false, reason: 'invalid-recipient' };
  }
  try {
    const response = await axios.post(config.sms.baseUrl, {
      api_key: config.sms.termiiApiKey,
      to: recipient,
      from: config.sms.senderId,
      sms: String(message).slice(0, 1600),
      type: 'plain',
      channel: 'generic',
    }, {
      headers: { 'Content-Type': 'application/json' },
      timeout: config.sms.timeoutMs,
    });
    const ok = response.data?.message === 'Successfully sent';
    logger.info('SMS accepted by Termii', { to: recipient.slice(0, 6), ok, messageId: response.data?.message_id || null });
    return { sent: ok, messageId: response.data?.message_id || null };
  } catch (err) {
    logger.error('SMS delivery error', { to: String(to).slice(0, 6), message: err.response?.data ? JSON.stringify(err.response.data) : err.message });
    return { sent: false, error: err.message };
  }
}

const NGN = (n) => `₦${parseFloat(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const SERVICE_LABELS = { airtime: 'Airtime', data: 'Data', electricity: 'Electricity', cable: 'Cable TV', 'exam-pin': 'Exam PIN', 'recharge-pin': 'Recharge PIN' };

function purchaseMessage(serviceType, amount, status) {
  const service = SERVICE_LABELS[serviceType] || serviceType;
  const amt = NGN(amount);
  if (status === 'success') return `TopFlowNG: ${service} purchase of ${amt} successful.`;
  if (status === 'pending') return `TopFlowNG: ${service} purchase of ${amt} is pending provider confirmation. Your wallet has not been debited.`;
  return `TopFlowNG: ${service} purchase of ${amt} could not be completed. No charge was made.`;
}

function walletMessage(amount, type) {
  const amt = NGN(amount);
  if (type === 'credit') return `TopFlowNG: ${amt} added to your wallet.`;
  if (type === 'debit') return `TopFlowNG: ${amt} debited from your wallet.`;
  return `TopFlowNG: Wallet update — ${amt}`;
}

function sendPurchaseSms(phone, { service, amount, outcome, reference }) {
  return sendSms(phone, `${purchaseMessage(service, amount, outcome)} Ref ${reference}`);
}

function sendWalletCreditSms(phone, { amount, balance, reference }) {
  return sendSms(phone, `${walletMessage(amount, 'credit')} New balance ${NGN(balance)}. Ref ${reference}`);
}

module.exports = {
  isSmsConfigured,
  normalizePhone,
  sendSms,
  sendPurchaseSms,
  sendWalletCreditSms,
  purchaseMessage,
  walletMessage,
};