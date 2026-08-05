/**
 * TopFlowNG — Email service (Resend HTTPS API).
 *
 * Extracted from server.js without behaviour change. Uses config for the API
 * URL, key, and from address. Never logs the API key or user PII.
 */

'use strict';

const axios = require('axios');

const config = require('../config');
const logger = require('../lib/logger');

async function sendEmail({ to, subject, html }) {
  if (!config.resend.apiKey) {
    throw new Error('Email delivery is not configured');
  }

  const response = await axios.post(config.resend.url, {
    from: config.resend.from,
    to: [to],
    subject,
    html,
  }, {
    headers: {
      Authorization: `Bearer ${config.resend.apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: config.resend.timeoutMs,
  });

  logger.info('Email accepted by Resend', { id: response.data?.data?.id || 'unknown id' });
}

function sendPurchaseEmail(userEmail, userName, { service, description, amount, reference, newBalance }) {
  const formatted = `₦${parseFloat(amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  const bal = `₦${parseFloat(newBalance).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  sendEmail({
    to: userEmail,
    subject: `TopFlowNG — ${service} purchase confirmed`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0E2235">Payment confirmed ✓</h2>
        <p>Hi ${userName},</p>
        <p>Your <strong>${service}</strong> purchase was successful.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Details</td><td style="padding:8px 0;font-size:13px;text-align:right">${description}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Amount</td><td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right">${formatted}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Reference</td><td style="padding:8px 0;font-size:12px;font-family:monospace;text-align:right">${reference}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">New balance</td><td style="padding:8px 0;font-size:13px;color:#1A7A4A;font-weight:600;text-align:right">${bal}</td></tr>
        </table>
        <p style="font-size:12px;color:#9CA3AF">If you didn't make this purchase, contact us immediately at support@topflowng.com</p>
        <p style="font-size:12px;color:#9CA3AF">— TopFlowNG</p>
      </div>
    `,
  }).catch(e => logger.error('Purchase email error', { message: e.message }));
}

module.exports = { sendEmail, sendPurchaseEmail };