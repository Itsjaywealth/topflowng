/**
 * TopFlowNG — Clubkonnect VTU provider client.
 *
 * Extracted from server.js without behaviour change. All provider URLs and
 * credentials come from config. Provider responses are normalised into a small
 * outcome object — never logged in full (only status/remark/orderId).
 */

'use strict';

const axios = require('axios');

const config = require('../config');
const db = require('../database');
const logger = require('../lib/logger');
const { ApiError } = require('../lib/errors');

const MAX_PURCHASE_AMOUNT = config.clubkonnect.maxPurchaseAmount;

function parseValidatedAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount <= 0 || amount > MAX_PURCHASE_AMOUNT) return null;
  return amount;
}

const CK_PENDING_CODES = new Set([100, 199, 201, 299, 300, 399, 412, 600, 601, 602, 603, 604, 605, 606, 699]);

function normalizeClubkonnectResponse(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : (raw || {});
  const rawCode = data.statusCode ?? data.StatusCode ?? data.statuscode ?? data.Statuscode;
  const legacyStatus = data.status ?? data.Status;
  const statusCode = rawCode !== undefined && rawCode !== null && rawCode !== ''
    ? Number(rawCode)
    : /^\d+$/.test(String(legacyStatus || '')) ? Number(legacyStatus) : null;
  const status = String(data.status ?? data.Status ?? '').trim().toUpperCase();
  const remark = String(data.remark ?? data.Remark ?? '').trim();
  const description = String(data.description ?? data.Description ?? data.message ?? data.Message ?? '').trim();
  // Nellobyte/Clubkonnect responses also report the reference as ordernumber.
  // Accept the first present value that looks like a real provider reference —
  // never a placeholder such as '0', 'undefined' or an empty string, which
  // would make an untraceable order falsely 'traceable' and burn query calls.
  const orderIdCandidates = [
    data.orderId, data.OrderID, data.OrderId,
    data.OrderNumber, data.ordernumber, data.orderNumber,
    data.order_id, data.OrderNo, data.orderno,
  ];
  const orderId = orderIdCandidates
    .map((v) => String(v ?? '').trim())
    .find((v) => v && v !== '0' && v.toLowerCase() !== 'undefined' && v.toLowerCase() !== 'null')
    || null;

  // Clubkonnect documents 200 as the only terminal delivery success. The
  // legacy API response format sometimes reports it as status: '200'.
  if (statusCode === 200 || (!statusCode && status === 'SUCCESSFUL')) {
    return { outcome: 'success', statusCode: 200, status: status || 'ORDER_COMPLETED', remark: remark || 'Success', description, orderId, raw: data };
  }

  // ORDER_RECEIVED, ORDER_PROCESSED, and ORDER_ONHOLD are non-terminal. This
  // deliberately includes ambiguity codes such as 199/299/399; no customer is
  // charged until the provider gives a terminal successful result.
  if (CK_PENDING_CODES.has(statusCode) || ['ORDER_RECEIVED', 'ORDER_PROCESSED', 'ORDER_ONHOLD'].includes(status) || /network unresponsive|awaiting|on hold|retry/i.test(`${remark} ${description}`)) {
    return { outcome: 'pending', statusCode, status, remark, description, orderId, raw: data };
  }

  // All documented ORDER_ERROR and ORDER_CANCELLED responses are terminal.
  // Authentication errors are also terminal even when this legacy endpoint
  // returns a text-only status rather than a numeric statusCode.
  // MISSING_*/INVALID_* responses are permanent validation rejections (the
  // provider declines the request, e.g. MISSING_PHONE_NUMBER) — never a
  // pending/resolvable state. Treating them as 'pending' surfaced a misleading
  // "awaiting provider confirmation" receipt to users.
  if ((statusCode >= 400 && statusCode <= 599 && statusCode !== 412)
    || ['ORDER_ERROR', 'ORDER_CANCELLED'].includes(status)
    || /^(MISSING|INVALID)_|AUTHENTICATION_FAILED|INVALID.*(?:KEY|CREDENTIAL|USER)|UNAUTHORIZED/i.test(`${status} ${remark} ${description}`)) {
    return { outcome: 'failed', statusCode, status, remark, description, orderId, raw: data };
  }

  // If the network returned an undocumented shape, preserve it for support and
  // reconciliation instead of risking an incorrect debit or false failure.
  return { outcome: 'pending', statusCode, status, remark, description, orderId, raw: data };
}

async function queryClubkonnectOrder(orderId) {
  const userId = config.clubkonnect.userId;
  const apiKey = config.clubkonnect.apiKey;
  if (!userId || !apiKey) {
    const error = new ApiError(503, 'Clubkonnect Query API is not configured');
    error.code = 'CLUBKONNECT_NOT_CONFIGURED';
    throw error;
  }

  try {
    const response = await axios.get(config.clubkonnect.queryUrl, {
      params: { UserID: userId, APIKey: apiKey, OrderID: orderId },
      timeout: config.clubkonnect.timeoutMs,
    });
    return normalizeClubkonnectResponse(response.data);
  } catch (err) {
    if (err.response?.data) return normalizeClubkonnectResponse(err.response.data);
    const error = new Error(`Clubkonnect Query API request failed: ${err.message}`);
    error.code = 'CLUBKONNECT_QUERY_UNREACHABLE';
    throw error;
  }
}

async function processClubkonnectPurchase({ userId, requestId, serviceType, amount, description, endpoint, params }) {
  await db.createVtuAttempt({ requestId, userId, serviceType, amount, description });

  let providerRaw;
  try {
    const providerUrl = endpoint.startsWith('http')
      ? endpoint
      : `${config.clubkonnect.baseUrl}${endpoint}`;
    const response = await axios.get(providerUrl, { params, timeout: config.clubkonnect.timeoutMs });
    providerRaw = response.data;
  } catch (err) {
    providerRaw = err.response?.data;
    if (!providerRaw) {
      // The provider may have received the request even though we timed out.
      // Hold the order and leave the wallet unchanged until it is reconciled.
      await db.recordVtuProviderResponse(requestId, {
        statusCode: null,
        status: 'UNKNOWN',
        remark: 'Provider connection unresolved',
        description: err.message,
        orderId: null,
        raw: { error: err.message },
      });
      await db.markVtuOrderPending(requestId);
      logger.warn(`Clubkonnect purchase pending reconciliation: ${requestId}`, { reason: err.message });
      return { outcome: 'pending', message: 'Your request is pending provider confirmation. Your wallet has not been debited.', requestId, orderId: null };
    }
  }

  const provider = normalizeClubkonnectResponse(providerRaw);
  await db.recordVtuProviderResponse(requestId, provider);

  if (provider.outcome === 'success') {
    try {
      const result = await db.completeVtuOrder(requestId);
      logger.info('Clubkonnect purchase completed', { requestId, orderId: provider.orderId || 'no provider order id' });
      return { outcome: 'success', balance: result.balance, requestId, orderId: provider.orderId, provider };
    } catch (err) {
      // Provider confirmed delivery, but the local settlement could not be
      // recorded (e.g. wallet is empty, or the DB write failed). The earlier
      // completeVtuOrder transaction rolled back, so the wallet is untouched
      // and the order is still 'submitted'. Park it in the reconcilable
      // 'pending' state with its provider reference intact instead of letting
      // a confirmed delivery silently fall out of the reconciliation set.
      logger.error('Clubkonnect confirmed delivery but local settlement failed; holding for reconciliation', {
        requestId,
        orderId: provider.orderId || 'no provider order id',
        message: err.message,
      });
      await db.markVtuOrderPending(requestId).catch(() => {});
      return {
        outcome: 'pending',
        message: 'Delivery was confirmed but the wallet debit could not be recorded. The order is held for reconciliation; your wallet has not been debited.',
        requestId,
        orderId: provider.orderId,
        provider,
      };
    }
  }

  if (provider.outcome === 'failed') {
    await db.markVtuOrderFailed(requestId);
    logger.warn('Clubkonnect purchase failed without wallet debit', { requestId, statusCode: provider.statusCode || 'unknown' });
    return { outcome: 'failed', message: provider.description || provider.remark || 'The provider declined this purchase.', requestId, orderId: provider.orderId, provider };
  }

  await db.markVtuOrderPending(requestId);
  logger.warn('Clubkonnect purchase pending reconciliation', { requestId, statusCode: provider.statusCode || 'unknown', remark: provider.remark || '' });
  return {
    outcome: 'pending',
    message: 'Your request is pending provider confirmation. Your wallet has not been debited.',
    requestId,
    orderId: provider.orderId,
    provider,
  };
}

module.exports = {
  MAX_PURCHASE_AMOUNT,
  parseValidatedAmount,
  CK_PENDING_CODES,
  normalizeClubkonnectResponse,
  queryClubkonnectOrder,
  processClubkonnectPurchase,
};
