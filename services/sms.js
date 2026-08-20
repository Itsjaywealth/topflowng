'use strict';

const axios = require('axios');
const config = require('../config');
const logger = require('./logger');

const TERMII_BASE = 'https://api.termii.com/api';

function isSmsConfigured() {
  return Boolean(config.sms?.termiiApiKey);
}

async function sendSms(to, message) {
  if (!isSmsConfigured()) {
    logger.info('SMS not configured — would send', { to, message: message.slice(0, 60) });
    return { sent: false, reason: 'not_configured' };
  }
  try {
    const response = await axios.post(`${TERMII_BASE}/sms/send`, {
      api_key: config.sms.termiiApiKey,
      to,
      from: config.sms.senderId || 'TopFlowNG',
      sms: message,
      type: 'plain',
      channel: 'generic',
    }, { timeout: 10000 });
    const ok = response.data?.message === 'Successfully sent';
    logger.info('SMS sent', { to, ok, messageId: response.data?.message_id || null });
    return { sent: ok, messageId: response.data?.message_id };
  } catch (err) {
    logger.error('SMS failed', { to, message: err.message });
    return { sent: false, error: err.message };
  }
}

function purchaseMessage(serviceType, amount, status) {
  const service = { airtime: 'Airtime', data: 'Data', electricity: 'Electricity', cable: 'Cable TV', 'exam-pin': 'Exam PIN', 'recharge-pin': 'Recharge PIN' }[serviceType] || serviceType;
  const amt = `₦${Number(amount).toLocaleString()}`;
  if (status === 'success') return `TopFlowNG: ${service} purchase of ${amt} successful.`;
  if (status === 'pending') return `TopFlowNG: ${service} purchase of ${amt} is pending confirmation. You have not been charged.`;
  return `TopFlowNG: ${service} purchase of ${amt} could not be completed. No charge was made.`;
}

function walletMessage(amount, type) {
  const amt = `₦${Number(amount).toLocaleString()}`;
  if (type === 'credit') return `TopFlowNG: ${amt} added to your wallet.`;
  if (type === 'debit') return `TopFlowNG: ${amt} debited from your wallet.`;
  return `TopFlowNG: Wallet update — ${amt}`;
}

module.exports = { sendSms, isSmsConfigured, purchaseMessage, walletMessage };