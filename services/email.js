/**
 * TopFlowNG — Email service (Resend + Brevo).
 *
 * Auto-detects provider from the API key prefix:
 *   re_        → Resend (https://api.resend.com/emails)
 *   xkeysib-   → Brevo  (https://api.brevo.com/v3/smtp/email)
 */

'use strict';

const axios = require('axios');

const config = require('../config');
const logger = require('../lib/logger');

function detectProvider(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith('re_')) return 'resend';
  if (apiKey.startsWith('xkeysib-')) return 'brevo';
  return 'resend';
}

async function sendEmail({ to, subject, html }) {
  const apiKey = config.resend.apiKey;
  if (!apiKey) throw new Error('Email delivery is not configured');

  const provider = detectProvider(apiKey);
  const from = config.resend.from;

  if (provider === 'brevo') {
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', {
      sender: { name: from.replace(/<.*>/, '').trim(), email: from.match(/<([^>]+)>/)?.[1] || from },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }, {
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: config.resend.timeoutMs,
    });
    logger.info('Email accepted by Brevo', { id: response.data?.messageId || 'unknown id' });
    return;
  }

  const response = await axios.post(config.resend.url, {
    from,
    to: [to],
    subject,
    html,
  }, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    timeout: config.resend.timeoutMs,
  });
  logger.info('Email accepted by Resend', { id: response.data?.data?.id || 'unknown id' });
}

function sendOrderStatusEmail(userEmail, userName, { service, description, amount, requestId, status, newBalance }) {
  const formatted = `₦${parseFloat(amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  const isSuccess = status === 'completed' || status === 'success';
  const subject = isSuccess
    ? `TopFlowNG — ${service} purchase confirmed`
    : `TopFlowNG — ${service} order update`;
  const body = isSuccess
    ? `<p>Your <strong>${service}</strong> purchase was successful.</p>
       <p>New balance: <strong>${formatted}</strong></p>`
    : `<p>Your <strong>${service}</strong> order could not be completed by the provider.</p>
       <p style="color:#DC2626;font-weight:600">Your wallet was NOT debited.</p>`;
  sendEmail({
    to: userEmail,
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0E2235">${isSuccess ? 'Payment confirmed ✓' : 'Order update'}</h2>
        <p>Hi ${userName},</p>
        ${body}
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Details</td><td style="padding:8px 0;font-size:13px;text-align:right">${description}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Amount</td><td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right">${formatted}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Reference</td><td style="padding:8px 0;font-size:12px;font-family:monospace;text-align:right">${requestId}</td></tr>
        </table>
        <p style="font-size:12px;color:#9CA3AF">If you didn't make this purchase, contact us immediately at support@topflowng.com</p>
        <p style="font-size:12px;color:#9CA3AF">— TopFlowNG</p>
      </div>
    `,
  }).catch(e => logger.error('Order status email error', { message: e.message }));
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

function sendAutoRechargeEmail(userEmail, userName, { amount, threshold, authorizationUrl, reference }) {
  const formatted = `₦${parseFloat(amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  const thresh = `₦${parseFloat(threshold).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  sendEmail({
    to: userEmail,
    subject: `TopFlowNG — Top up ${formatted} to keep your account running`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0E2235">Your balance dropped below ${thresh}</h2>
        <p>Hi ${userName},</p>
        <p>Your wallet balance fell below your auto-recharge threshold, so we started a
           top-up of <strong>${formatted}</strong> for you.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Top-up amount</td><td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right">${formatted}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Threshold</td><td style="padding:8px 0;font-size:13px;text-align:right">${thresh}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Reference</td><td style="padding:8px 0;font-size:12px;font-family:monospace;text-align:right">${reference}</td></tr>
        </table>
        <p>Just click below to complete the payment — your balance is credited instantly:</p>
        <a href="${authorizationUrl}"
          style="display:inline-block;background:#00A868;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;margin:8px 0">
          Complete top-up of ${formatted}
        </a>
        <p style="font-size:12px;color:#9CA3AF">The link expires after 24 hours. If you didn't set up auto-recharge, ignore this email.</p>
        <p style="font-size:12px;color:#9CA3AF">— TopFlowNG</p>
      </div>
    `,
  }).catch(e => logger.error('Auto-recharge email error', { message: e.message }));
}

module.exports = { sendEmail, sendPurchaseEmail, sendOrderStatusEmail, sendAutoRechargeEmail };
