'use strict';

/**
 * TopFlowNG — BizFlowNG expense sync service.
 *
 * A customer may explicitly link their BizFlowNG business account and opt
 * individual successful business purchases into becoming BizFlowNG expenses.
 *
 * Safety model:
 *   - Linking is explicit and per-customer; the BizFlowNG API key is stored
 *     encrypted (AES-256-GCM) and never returned by any API.
 *   - Only successful, customer-approved transactions in approved categories
 *     are queued; personal purchases are never auto-synced.
 *   - Idempotent end-to-end: bizflow_syncs.reference is UNIQUE on TopFlowNG,
 *     and BizFlowNG dedupes on the same reference.
 *   - Delivery is retry-safe with capped exponential backoff and a dead state.
 *   - Every state change is audit-logged. Failures never affect the wallet.
 */

const crypto = require('crypto');
const axios = require('axios');
const config = require('../config');
const logger = require('../lib/logger');
const events = require('./events');

function lazyDb() {
  return require('../database');
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.bizflow.encryptionKey, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${enc.toString('base64')}`;
}

function decryptSecret(stored) {
  const [ivB64, tagB64, encB64] = String(stored).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', config.bizflow.encryptionKey, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64')), decipher.final()]).toString('utf8');
}

function fingerprint(secret) {
  return crypto.createHash('sha256').update(String(secret)).digest('hex').slice(0, 12);
}

/**
 * Verify a customer-provided BizFlowNG integration key against their instance.
 * Returns { ok, businessId?, status: 'active'|'unverified', detail }.
 */
async function verifyLink({ baseUrl, apiKey }) {
  if (!baseUrl) return { ok: false, status: 'unverified', detail: 'No BizFlowNG URL configured' };
  try {
    const res = await axios.get(baseUrl.replace(/\/$/, '') + config.bizflow.verifyPath, {
      timeout: 8000,
      headers: { 'x-bizflow-key': apiKey },
      validateStatus: () => true,
    });
    if (res.status === 200 && res.data && res.data.ok) {
      return { ok: true, status: 'active', businessId: res.data.business?.id || res.data.business_id || null, detail: 'verified' };
    }
    return { ok: false, status: 'unverified', detail: `BizFlowNG responded HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: 'unverified', detail: err.message };
  }
}

/**
 * Deliver one queued sync row to the linked BizFlowNG instance.
 */
async function deliverSync(row) {
  const db = lazyDb();
  const baseUrl = row.bizflow_base_url || config.bizflow.apiUrl;
  if (!baseUrl) {
    await db.markBizflowSyncResult(row.id, { error: 'No BizFlowNG URL configured' });
    return false;
  }
  const apiKey = decryptSecret(row.api_key_enc);
  const body = JSON.stringify({
    source: 'topflowng',
    reference: row.reference,           // idempotency key on the BizFlowNG side
    business_id: row.bizflow_business_id,
    category: row.category,
    amount: Number(row.amount),
    description: row.description || `TopFlowNG ${row.category} purchase ${row.reference}`,
    incurred_at: new Date().toISOString(),
  });
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = events.signPayload(apiKey, body, timestamp).signature;
  try {
    const res = await axios.post(baseUrl.replace(/\/$/, '') + config.bizflow.syncPath, body, {
      timeout: config.events.timeoutMs,
      headers: {
        'Content-Type': 'application/json',
        'x-bizflow-key': apiKey,
        'x-topflow-timestamp': String(timestamp),
        'x-topflow-signature': signature,
        'x-topflow-source': 'topflowng',
      },
      validateStatus: () => true,
      maxRedirects: 0,
    });
    if (res.status >= 200 && res.status < 300) {
      await db.markBizflowSyncResult(row.id, { synced: true, bizflowExpenseId: res.data?.expenseId || res.data?.expense?.id || res.data?.id || null });
      await events.emit('topflow.bizflow.expense.synced', {
        reference: row.reference, category: row.category, amount: Number(row.amount),
        bizflow_expense_id: res.data?.expense?.id || res.data?.id || null,
      }, { entityType: 'bizflow_sync', entityId: row.reference });
      await events.emit('topflow.bizflow.sync.ready', {
        reference: row.reference, expense_id: res.data?.expense?.id || res.data?.id || null,
      }, { entityType: 'bizflow_sync', entityId: row.reference }).catch(() => {});
      await events.audit('bizflow.sync.delivered', {
        actorType: 'customer', actorId: row.user_id,
        entityType: 'bizflow_sync', entityId: row.reference,
        metadata: { category: row.category, amount: Number(row.amount) },
      });
      return true;
    }
    // 4xx (except 408/429) are permanent — do not keep retrying a rejected sync.
    const permanent = res.status >= 400 && res.status < 500 && res.status !== 408 && res.status !== 429;
    await db.markBizflowSyncResult(row.id, { error: `HTTP ${res.status}`, dead: permanent });
    return false;
  } catch (err) {
    await db.markBizflowSyncResult(row.id, { error: err.message });
    return false;
  }
}

async function processSyncQueue(limit = 25) {
  const db = lazyDb();
  const rows = await db.getBizflowSyncsForDelivery({ limit });
  let synced = 0;
  for (const row of rows) {
    try {
      if (await deliverSync(row)) synced += 1;
    } catch (err) {
      logger.warn('bizflow sync crashed', { reference: row.reference, message: err.message });
    }
  }
  return { attempted: rows.length, synced };
}

function startSyncSweep(intervalMs = 5 * 60 * 1000) {
  const timer = setInterval(() => {
    processSyncQueue().catch((err) => logger.warn('bizflow sync sweep failed', { message: err.message }));
  }, intervalMs);
  timer.unref();
  return timer;
}

module.exports = { encryptSecret, decryptSecret, fingerprint, verifyLink, deliverSync, processSyncQueue, startSyncSweep };
