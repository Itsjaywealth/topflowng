'use strict';

/**
 * TopFlowNG — provider catalogue sync.
 *
 * Reconciles every purchasable plan against VTPass's LIVE
 * /service-variations on a schedule, so the backend never silently sells a
 * bundle the provider no longer stocks or at a price below provider cost.
 *
 * Per plan, one of:
 *   OK                   — mapped, present at provider, retail ≥ provider cost
 *   MISSING_AT_PROVIDER  — mapped here, gone at VTPass → orders would fail
 *   UNMAPPED             — priced here, never mapped to a provider variation
 *   PRICE_BELOW_COST     — retail price is BELOW live provider cost (selling at a loss)
 *   NEW_AT_PROVIDER      — purchasable at VTPass but not offered to customers
 *
 * Read-only: this module never mutates pricing or mappings — it reports.
 */

const logger = require('../lib/logger');
const vtpass = require('./vtpass');
const { DATA_SERVICE = {}, CABLE_SERVICE = {}, PRODUCT_MAP = {}, fetchVariations } = vtpass;
const { DATA_PLANS = {}, CABLE_PLANS = {}, EXAM_PRICES = {} } = require('./pricing');

const SYNCED_AT_PROVIDER = '2026-08-18';

function retailForData(code) {
  for (const plans of Object.values(DATA_PLANS)) {
    const hit = plans.find((p) => p.code === code);
    if (hit) return hit.price;
  }
  return null;
}

function retailForCable(code) {
  for (const plans of Object.values(CABLE_PLANS)) {
    const hit = plans.find((p) => p.code === code);
    if (hit) return hit.price;
  }
  return null;
}

/**
 * Pure reconciliation for one provider service group.
 * @param {Array<{code:string, retail:number}>} mapped offered plans w/ retail prices
 * @param {Array<{variation_code:string, variation_amount:number|string}>} live provider variations
 */
function reconcileGroup(groupLabel, mapped, live) {
  const byCode = new Map((live || []).map((v) => [String(v.variation_code), Number(v.variation_amount)]));
  const rows = [];
  const seenLive = new Set();

  for (const { code, retail } of mapped) {
    if (!byCode.has(code)) {
      rows.push({ group: groupLabel, code, state: 'MISSING_AT_PROVIDER', retail });
      continue;
    }
    seenLive.add(code);
    const cost = byCode.get(code);
    if (Number.isFinite(cost) && retail != null && retail < cost) {
      rows.push({ group: groupLabel, code, state: 'PRICE_BELOW_COST', retail, providerCost: cost });
      continue;
    }
    rows.push({ group: groupLabel, code, state: 'OK', retail, providerCost: cost });
  }

  for (const [code, cost] of byCode.entries()) {
    if (!seenLive.has(code)) rows.push({ group: groupLabel, code, state: 'NEW_AT_PROVIDER', providerCost: cost });
  }

  // Unmapped offered plans (priced but never mapped to a variation).
  const mappedCodes = new Set(mapped.map((m) => m.code));
  void mappedCodes;
  return rows;
}

async function buildMappedInventory() {
  const groups = [];

  // Data — per network.
  for (const [network, serviceID] of Object.entries(DATA_SERVICE)) {
    const mapped = (DATA_PLANS[network] || [])
      .map((p) => ({ code: (PRODUCT_MAP.data || {})[p.code], retail: p.price, planCode: p.code }))
      .filter((p) => Boolean(p.code));
    groups.push({ label: `data:${network}`, serviceID, mapped });
  }

  // Cable — per TV provider.
  const cablePrefixes = { DSTV: 'dstv', GOTV: 'gotv', STARTIMES: 'startimes' };
  for (const [provider, serviceID] of Object.entries(CABLE_SERVICE)) {
    const prefix = cablePrefixes[provider] || provider.toLowerCase();
    const mapped = Object.entries(PRODUCT_MAP.cable || {})
      .filter(([code]) => code.toLowerCase().startsWith(prefix.slice(0, 2)))
      .map(([planCode, variation]) => ({ code: variation, retail: retailForCable(planCode), planCode }));
    groups.push({ label: `cable:${provider}`, serviceID, mapped });
  }

  // Exam PINs.
  for (const [body, def] of Object.entries(PRODUCT_MAP.exam || {})) {
    if (typeof def !== 'object' || !def.serviceID) continue;
    const retail = EXAM_PRICES[body] ?? null;
    const mapped = [{ code: def.variation, retail: typeof retail === 'object' ? null : retail, planCode: body }];
    groups.push({ label: `exam:${body}`, serviceID: def.serviceID, mapped });
  }

  return groups.filter((g) => g.mapped.length > 0);
}

let lastReport = null;

/**
 * Pull live variations for every group and classify every offered plan.
 * Never throws — failures are recorded in the report so operators see them.
 */
async function syncCatalog() {
  const startedAt = new Date().toISOString();
  const report = { startedAt, finishedAt: null, ok: true, groups: [], issues: [], counts: {} };
  try {
    const groups = await buildMappedInventory();
    for (const g of groups) {
      let live = [];
      try {
        live = await fetchVariations(g.serviceID);
      } catch (err) {
        report.ok = false;
        report.groups.push({ group: g.label, serviceID: g.serviceID, error: err.message, checked: 0 });
        report.issues.push({ group: g.label, code: null, state: 'PROVIDER_UNREACHABLE', detail: err.message });
        continue;
      }
      const rows = reconcileGroup(g.label, g.mapped, live);
      report.groups.push({ group: g.label, serviceID: g.serviceID, checked: rows.length, rows });
      for (const row of rows) {
        if (row.state !== 'OK' && row.state !== 'NEW_AT_PROVIDER') report.issues.push(row);
        else if (row.state === 'NEW_AT_PROVIDER') report.issues.push({ ...row, note: 'offered at provider but not in the customer catalogue' });
      }
    }
  } catch (err) {
    report.ok = false;
    report.issues.push({ state: 'SYNC_ERROR', detail: err.message });
    logger.error('Catalog sync failed', { detail: err.message });
  }

  report.counts = report.groups.reduce((acc, g) => acc + (g.checked || 0), 0);
  report.finishedAt = new Date().toISOString();
  lastReport = report;

  const blocking = report.issues.filter((i) => i.state === 'MISSING_AT_PROVIDER' || i.state === 'PRICE_BELOW_COST');
  if (blocking.length > 0) {
    logger.error('CATALOG SYNC: plans need attention', {
      count: blocking.length,
      detail: blocking.map((i) => `${i.state}:${i.group}:${i.code}`).join(',').slice(0, 400),
    });
  }
  return report;
}

function getLastReport() {
  return lastReport;
}

module.exports = { syncCatalog, getLastReport, reconcileGroup, buildMappedInventory, SYNCED_AT_PROVIDER };
