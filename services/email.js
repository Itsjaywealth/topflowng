/**
 * TopFlowNG — Email service.
 *
 * Delivery providers, in priority order:
 *   1. SMTP (e.g. Hostinger mailbox hello@topflowng.com) when SMTP_HOST and
 *      SMTP_USER/SMTP_PASSWORD are configured.
 *   2. Resend / Brevo (auto-detected from the API key prefix):
 *        re_        → Resend (https://api.resend.com/emails)
 *        xkeysib-   → Brevo  (https://api.brevo.com/v3/smtp/email)
 *
 * Reply-To is always set to the official support address so customer replies
 * land in the real mailbox even when delivery goes through an API provider.
 */

'use strict';

const axios = require('axios');
const nodemailer = require('nodemailer');

const config = require('../config');
const logger = require('../lib/logger');

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function detectProvider(apiKey) {
  if (!apiKey) return null;
  if (apiKey.startsWith('re_')) return 'resend';
  if (apiKey.startsWith('xkeysib-')) return 'brevo';
  return 'resend';
}

function isSmtpConfigured() {
  return Boolean(config.smtp.host && config.smtp.user && config.smtp.password);
}

async function sendViaSmtp({ to, subject, html, replyTo }) {
  const transporter = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: { user: config.smtp.user, pass: config.smtp.password },
    connectionTimeout: config.smtp.timeoutMs,
    greetingTimeout: config.smtp.timeoutMs,
    socketTimeout: config.smtp.timeoutMs,
  });
  const info = await transporter.sendMail({
    from: config.smtp.from,
    to,
    subject,
    html,
    ...(replyTo ? { replyTo } : {}),
  });
  logger.info('Email accepted by SMTP', { id: info.messageId || 'unknown id' });
}

async function sendEmail({ to, subject, html, replyTo }) {
  if (isSmtpConfigured()) {
    try {
      await sendViaSmtp({ to, subject, html, replyTo });
      return;
    } catch (err) {
      logger.warn("SMTP delivery failed, falling back to API", { message: err.message });
    }
  }

  const apiKey = config.resend.apiKey;
  if (!apiKey) throw new Error('Email delivery is not configured');

  const provider = detectProvider(apiKey);
  const from = config.resend.from;

  if (provider === 'brevo') {
    const payload = {
      sender: { name: from.replace(/<.*>/, '').trim(), email: from.match(/<([^>]+)>/)?.[1] || from },
      to: [{ email: to }],
      subject,
      htmlContent: html,
    };
    if (replyTo) payload.replyTo = replyTo;
    const response = await axios.post('https://api.brevo.com/v3/smtp/email', payload, {
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
    ...(replyTo ? { reply_to: replyTo } : {}),
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
    ? `<p>Your <strong>${escapeHtml(service)}</strong> purchase was successful.</p>
       <p>New balance: <strong>${formatted}</strong></p>`
    : `<p>Your <strong>${service}</strong> order could not be completed by the provider.</p>
       <p style="color:#DC2626;font-weight:600">Your wallet was NOT debited.</p>`;
  sendEmail({
    to: userEmail,
    subject,
    replyTo: config.supportEmail,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0E2235">${isSuccess ? 'Payment confirmed ✓' : 'Order update'}</h2>
        <p>Hi ${escapeHtml(userName)},</p>
        ${body}
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Details</td><td style="padding:8px 0;font-size:13px;text-align:right">${escapeHtml(description)}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Amount</td><td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right">${formatted}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Reference</td><td style="padding:8px 0;font-size:12px;font-family:monospace;text-align:right">${escapeHtml(requestId)}</td></tr>
        </table>
        <p style="font-size:12px;color:#9CA3AF">If you didn't make this purchase, contact us immediately at ${config.supportEmail}</p>
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
    replyTo: config.supportEmail,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0E2235">Payment confirmed ✓</h2>
        <p>Hi ${escapeHtml(userName)},</p>
        <p>Your <strong>${escapeHtml(service)}</strong> purchase was successful.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Details</td><td style="padding:8px 0;font-size:13px;text-align:right">${escapeHtml(description)}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Amount</td><td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right">${formatted}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Reference</td><td style="padding:8px 0;font-size:12px;font-family:monospace;text-align:right">${escapeHtml(reference)}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">New balance</td><td style="padding:8px 0;font-size:13px;color:#1A7A4A;font-weight:600;text-align:right">${bal}</td></tr>
        </table>
        <p style="font-size:12px;color:#9CA3AF">If you didn't make this purchase, contact us immediately at ${config.supportEmail}</p>
        <p style="font-size:12px;color:#9CA3AF">— TopFlowNG</p>
      </div>
    `,
  }).catch(e => logger.error('Purchase email error', { message: e.message }));
}

function sendInvoiceEmail(clientEmail, { invoice, client, ownerName, ownerCompany, paymentUrl }) {
  const fmt = (n) => `₦${parseFloat(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const rows = (invoice.items || []).map(item => `
    <tr>
      <td style="padding:10px 8px;border-bottom:1px solid #EEF2F6">${escapeHtml(item.desc || 'Item')}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #EEF2F6;text-align:center">${item.qty || 1}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #EEF2F6;text-align:right">${fmt(item.price)}</td>
      <td style="padding:10px 8px;border-bottom:1px solid #EEF2F6;text-align:right;font-weight:600">${fmt((item.qty || 1) * (item.price || 0))}</td>
    </tr>`).join('');
  const due = invoice.due ? `<tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Due date</td><td style="padding:8px 0;font-size:13px;text-align:right">${new Date(invoice.due).toLocaleDateString('en-NG', { day: 'numeric', month: 'short', year: 'numeric' })}</td></tr>` : '';
  const payButton = paymentUrl ? `
    <div style="text-align:center;margin:20px 0">
      <a href="${escapeHtml(paymentUrl)}"
         style="display:inline-block;background:#0B7E8E;color:#fff;text-decoration:none;padding:14px 32px;border-radius:10px;font-weight:700;font-size:15px">
        Pay Now — ${fmt(invoice.total)}
      </a>
    </div>
    <p style="font-size:12px;color:#9CA3AF;text-align:center">Pay securely via Paystack. Powered by TopFlowNG.</p>` : '';
  sendEmail({
    to: clientEmail,
    subject: `Invoice #${invoice.id} from ${ownerCompany || 'Your business'} — ${fmt(invoice.total)}`,
    replyTo: config.supportEmail,
    html: `
      <div style="font-family:sans-serif;max-width:520px;margin:0 auto">
        <h2 style="color:#0E2235;margin:0 0 4px">Invoice #${escapeHtml(invoice.id)}</h2>
        <p style="margin:0;color:#6B7280;font-size:13px">From ${escapeHtml(ownerName || ownerCompany || 'Your business')}</p>
        <p style="margin:4px 0 20px;color:#6B7280;font-size:13px">To ${escapeHtml(client.name || invoice.clientName)}</p>
        ${payButton}
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr>
              <th style="text-align:left;font-size:12px;color:#6B7280;padding:8px;border-bottom:2px solid #E5E7EB">Description</th>
              <th style="text-align:center;font-size:12px;color:#6B7280;padding:8px;border-bottom:2px solid #E5E7EB">Qty</th>
              <th style="text-align:right;font-size:12px;color:#6B7280;padding:8px;border-bottom:2px solid #E5E7EB">Price</th>
              <th style="text-align:right;font-size:12px;color:#6B7280;padding:8px;border-bottom:2px solid #E5E7EB">Amount</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <table style="width:100%;border-collapse:collapse;margin-top:12px">
          <tr><td style="padding:6px 8px;color:#6B7280;font-size:13px">Subtotal</td><td style="padding:6px 8px;font-size:13px;text-align:right">${fmt(invoice.subtotal)}</td></tr>
          <tr><td style="padding:6px 8px;color:#6B7280;font-size:13px">VAT (7.5%)</td><td style="padding:6px 8px;font-size:13px;text-align:right">${fmt(invoice.vat)}</td></tr>
          <tr>
            <td style="padding:10px 8px;border-top:2px solid #E5E7EB;font-weight:700;color:#0E2235">Total</td>
            <td style="padding:10px 8px;border-top:2px solid #E5E7EB;font-weight:700;color:#0E2235;text-align:right">${fmt(invoice.total)}</td>
          </tr>
          ${due}
        </table>
        ${invoice.notes ? `<p style="margin:16px 0 0;color:#374151;font-size:13px">${escapeHtml(invoice.notes)}</p>` : ''}
        ${!paymentUrl ? `<p style="font-size:12px;color:#9CA3AF;margin:24px 0 0">This invoice was sent from TopFlowNG BizFlow. If you have any questions, reply to this email.</p>` : ''}
      </div>
    `,
  });
}

function sendAutoRechargeEmail(userEmail, userName, { amount, threshold, authorizationUrl, reference }) {
  const formatted = `₦${parseFloat(amount).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  const thresh = `₦${parseFloat(threshold).toLocaleString('en-NG', { minimumFractionDigits: 2 })}`;
  let safeUrl = '#';
  try {
    const parsed = new URL(authorizationUrl);
    if (parsed.protocol === 'https:' && parsed.hostname.endsWith('paystack.com')) safeUrl = parsed.href;
  } catch { /* invalid checkout URL remains inert */ }
  sendEmail({
    to: userEmail,
    subject: `TopFlowNG — Top up ${formatted} to keep your account running`,
    replyTo: config.supportEmail,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
        <h2 style="color:#0E2235">Your balance dropped below ${thresh}</h2>
        <p>Hi ${escapeHtml(userName)},</p>
        <p>Your wallet balance fell below your reminder threshold, so we prepared a
           Paystack checkout for <strong>${formatted}</strong>. Nothing has been charged automatically.</p>
        <table style="width:100%;border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Top-up amount</td><td style="padding:8px 0;font-size:13px;font-weight:600;text-align:right">${formatted}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Threshold</td><td style="padding:8px 0;font-size:13px;text-align:right">${thresh}</td></tr>
          <tr><td style="padding:8px 0;color:#6B7280;font-size:13px">Reference</td><td style="padding:8px 0;font-size:12px;font-family:monospace;text-align:right">${escapeHtml(reference)}</td></tr>
        </table>
        <p>Just click below to complete the payment — your balance is credited instantly:</p>
        <a href="${escapeHtml(safeUrl)}"
          style="display:inline-block;background:#00A868;color:#fff;text-decoration:none;padding:12px 22px;border-radius:10px;font-weight:700;margin:8px 0">
          Complete top-up of ${formatted}
        </a>
        <p style="font-size:12px;color:#9CA3AF">The link expires after 24 hours. If you didn't set up this reminder, ignore this email.</p>
        <p style="font-size:12px;color:#9CA3AF">— TopFlowNG</p>
      </div>
    `,
  }).catch(e => logger.error('Auto-recharge email error', { message: e.message }));
}

module.exports = { sendEmail, sendPurchaseEmail, sendOrderStatusEmail, sendAutoRechargeEmail, sendInvoiceEmail, isSmtpConfigured };
