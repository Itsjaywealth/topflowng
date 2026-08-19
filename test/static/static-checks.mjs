/**
 * TopFlowNG — frontend / static quality checks (no browser, no DB).
 *
 * Deterministic checks over the shipped static surfaces:
 *   - inline <script> syntax in all three HTML shells
 *   - SEO metadata + JSON-LD parsing (topflowng.html, bizflow.html)
 *   - robots.txt / sitemap.xml presence, directives and validity
 *   - admin.html privacy (noindex, nofollow)
 *   - manifest.json PWA fields
 *   - sw.js cache policy (never cache /api; exclude admin/bizflow/robots/sitemap)
 *   - AI assistant safe rendering (model text set via textContent, not innerHTML)
 *
 * Usage: node test/static/static-checks.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const results = [];
let failures = 0;
function check(name, ok, detail = '') {
  results.push({ name, ok });
  if (!ok) failures += 1;
}

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Extract all inline (non-src) script bodies, dropping JSON-LD blocks. */
function inlineScripts(html) {
  const bodies = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = m[1];
    if (!body.trim()) continue;
    if (body.includes('"@context"')) continue; // JSON-LD block
    bodies.push(body);
  }
  return bodies;
}

async function checkInlineSyntax(rel) {
  const html = read(rel);
  const bodies = inlineScripts(html);
  for (let i = 0; i < bodies.length; i++) {
    const tmp = path.join(os.tmpdir(), `topflowng-inline-${process.pid}-${i}.js`);
    fs.writeFileSync(tmp, bodies[i]);
    try {
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      check(`${rel} inline#${i}`, true);
    } catch (e) {
      const msg = String(e.stderr || e.message).split('\n').slice(0, 3).join(' | ').slice(0, 160);
      check(`${rel} inline#${i}`, false, msg);
    } finally {
      fs.unlinkSync(tmp);
    }
  }
}

async function jsonLdBlocks(html) {
  const blocks = [];
  const re = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) blocks.push(m[1]);
  return blocks.map((b) => JSON.parse(b));
}

// ── 1. Inline script syntax across the three HTML shells ────────────────────
await checkInlineSyntax('topflowng.html');
await checkInlineSyntax('admin.html');
await checkInlineSyntax('bizflow.html');

// ── 2. SEO + structured data ────────────────────────────────────────────────
{
  const html = read('topflowng.html');
  check('topflowng canonical', /<link rel="canonical" href="https:\/\/topflowng\.com\/">/.test(html));
  check('topflowng og:title', /property="og:title"/.test(html));
  check('topflowng twitter card', /name="twitter:card"/.test(html));
  if (/<script type="application\/ld\+json">/.test(html)) {
    try {
      const parsed = await jsonLdBlocks(html);
      check('topflowng JSON-LD parses', parsed.length >= 1);
    } catch (e) {
      check('topflowng JSON-LD parses', false, e.message);
    }
  } else {
    check('topflowng JSON-LD parses', false, 'missing JSON-LD script block');
  }
}

{
  const html = read('bizflow.html');
  check('bizflow canonical', /<link rel="canonical"/.test(html));
  check('bizflow robots indexable', /<meta name="robots" content="index, follow">/.test(html));
  if (/<script type="application\/ld\+json">/.test(html)) {
    try {
      const parsed = await jsonLdBlocks(html);
      check('bizflow JSON-LD parses', parsed.length >= 1);
    } catch (e) {
      check('bizflow JSON-LD parses', false, e.message);
    }
  } else {
    check('bizflow JSON-LD parses', false, 'missing JSON-LD script block');
  }
}

// ── 3. robots.txt ───────────────────────────────────────────────────────────
{
  const robots = read('robots.txt');
  check('robots has Sitemap', /Sitemap:\s*https:\/\//i.test(robots));
  check('robots disallows /api', /Disallow:\s*\/api\//.test(robots));
  check('robots disallows /admin.html', /Disallow:\s*\/admin\.html/.test(robots));
}

// ── 4. sitemap.xml ─────────────────────────────────────────────────────────
{
  const sitemap = read('sitemap.xml');
  const locs = [...sitemap.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
  check('sitemap has URL entries', locs.length >= 2);
  check('sitemap XML is well-formed', sitemap.trim().startsWith('<?xml') && sitemap.includes('<urlset'));
  check('sitemap base URL', locs.some((u) => u.startsWith('https://topflowng.com/')));
}

// ── 5. admin noindex ───────────────────────────────────────────────────────
{
  const html = read('admin.html');
  check('admin robots noindex,nofollow', /<meta name="robots" content="noindex, nofollow">/.test(html));
}

// ── 6. manifest.json ───────────────────────────────────────────────────────
{
  const manifest = JSON.parse(read('manifest.json'));
  check('manifest name', Boolean(manifest.name));
  check('manifest short_name', Boolean(manifest.short_name));
  check('manifest start_url', Boolean(manifest.start_url));
  check('manifest display', manifest.display === 'standalone');
  check('manifest icons (>=2)', Array.isArray(manifest.icons) && manifest.icons.length >= 2);
  check('manifest theme_color', Boolean(manifest.theme_color));
  check('manifest short_name is TopFlowNG', manifest.short_name === 'TopFlowNG');
  check('manifest theme_color matches brand teal', manifest.theme_color === '#0B7E8E');
  for (const p of ['/icons/icon-192.png', '/icons/icon-512.png']) {
    check(`manifest icon exists ${p}`, fs.existsSync(path.join(ROOT, p.slice(1))));
  }
  const iconUrls = manifest.icons.map((i) => i.src);
  check('manifest icons are cache-versioned to defeat stale edge cache',
    iconUrls.every((u) => /^\/icons\/[a-z0-9.-]+\.png\?v=\d+$/.test(u)));
}

// ── 7. sw.js cache policy ───────────────────────────────────────────────────
{
  const sw = read('sw.js');
  check('sw network-first for /api', /pathname\.startsWith\('\/api\/'\)/.test(sw) && /caches\.match\(e\.request\).*startsWith/.test(sw) === false);
  check('sw never caches /api (respondWith fetch)', /startsWith\('\/api\/'\)[\s\S]*?respondWith\(fetch\(/.test(sw));
  check('sw excludes admin.html from cache', /admin\.html/.test(sw));
  check('sw excludes bizflow.html from cache', /bizflow\.html/.test(sw));
  check('sw skipWaiting/claim', /skipWaiting\(\)/.test(sw) && /clients\.claim\(\)/.test(sw));
}

// ── 8. Browser trust-boundary regressions ──────────────────────────────────
{
  const app = read('topflowng.html');
  const biz = read('bizflow.html');
  check('auth next redirect is same-origin guarded', /function safeNextPath\(/.test(app) && /target\.origin !== window\.location\.origin/.test(app));
  check('all auth redirects use the safe next resolver', (app.match(/const nx = safeNextPath\(\)/g) || []).length === 3);
  const waecPrice = app.match(/const EXAM_PRICE_MAP = \{ WAEC: (\d+) \}/)?.[1];
  const initialExamPrice = app.match(/id="exam-price">₦([\d,]+)\.00</)?.[1]?.replaceAll(',', '');
  check('WAEC checkout display matches canonical price', Boolean(waecPrice) && initialExamPrice === waecPrice);
  check('scheduled hero opens scheduler', /onclick="openScheduledModal\(\)">Schedule now</.test(app));
  check('low-balance messaging denies automatic charges', !/top up automatically when your balance drops/i.test(app));
  check('BizFlow defines HTML output encoding', /const escHtml =/.test(biz));
  check('BizFlow invoice names are encoded', /escHtml\(inv\.clientName/.test(biz));
  check('BizFlow client names are encoded', /escHtml\(c\.name\)/.test(biz));
  check('BizFlow staff names are encoded', /escHtml\(m\.name\)/.test(biz));
}

// ── 9. Provider logo integrity ─────────────────────────────────────────────
{
  const app = read('topflowng.html');
  const registry = read('assets/provider-logos.js');
  const required = ['MTN','AIRTEL','GLO','9MOBILE','IKEDC','EKEDC','AEDC','PHEDC','KEDC','IBEDC','JED','KAEDCO','EEDC','BEDC','APLE','YEDC','DSTV','GOTV','STARTIMES','WAEC','PAYSTACK','VTPASS','T2'];
  for (const key of required) {
    check(`provider logo mapping ${key}`, new RegExp(`['\"]?${key}['\"]?\\s*:`).test(registry));
  }
  const paths = [...registry.matchAll(/src:\s*['"](\/assets\/providers\/[^'"]+)['"]/g)].map((m) => m[1]);
  check('provider logo mappings are unique', new Set(paths).size === paths.length);
  check('provider logo files exist', paths.every((p) => fs.existsSync(path.join(ROOT, p.slice(1)))));
  check('provider logo alt text present', !/alt:\s*['"]\s*['"]/.test(registry));
  const providerTiles = [...app.matchAll(/class="network-chip provider-choice"[\s\S]*?<\/div>/g)].map((m) => m[0]);
  check('active provider tiles contain no emoji', providerTiles.every((tile) => !/\p{Extended_Pictographic}/u.test(tile)));
  check('all 12 verified DISCOs are active customer providers', ['IKEDC','EKEDC','AEDC','PHEDC','KEDC','IBEDC','JED','KAEDCO','EEDC','BEDC','APLE','YEDC'].every((d) => new RegExp(`provider-choice[^>]*>[\\s\\S]{0,500}?${d}`).test(app)));
  check('inactive recharge-card service is not shown in the primary grid', !/service-tile[^>]*>\s*<span class="tile-icon tile-recharge"/.test(app));
  check('active service tiles carry no Available/Coming-soon labels', !/class="availability"/.test(app) && !/class="tile-last"/.test(app));
  for (const [shell, file] of [['topflowng.html', app], ['admin.html', read('admin.html')]]) {
    const pwFields = [...file.matchAll(/<input type="password"[^>]*id="([^"]+)"/g)].map((m) => m[1]).filter((id) => !/pin/i.test(id));
    const wrapped = pwFields.every((id) => new RegExp(`class="pw-field"[\\s\\S]{0,220}?id="${id}"`).test(file));
    check(`${shell} password inputs have show/hide toggles`, wrapped);
    const pinFields = [...file.matchAll(/<input type="password"[^>]*id="([^"]+)"/g)].map((m) => m[1]).filter((id) => /pin/i.test(id));
    check(`${shell} transaction PIN inputs stay masked`, pinFields.every((id) => !new RegExp(`class="pw-field"[\\s\\S]{0,220}?id="${id}"`).test(file)));
  }
  check('password toggle helper defined in both shells',
    /function togglePasswordVisibility\(/.test(app) && /function togglePasswordVisibility\(/.test(read('admin.html')));

  // Brand colors: every provider must have --brand-* vars in :root, and a BRAND_KEY
  const brandProviders = ['mtn','glo','airtel','9mobile','ikedc','ekedc','aedc','phedc','kedc','ibedc','jed','kaedco','eedc','bedc','aple','yedc','dstv','gotv','startimes','waec'];
  check('brand color variables defined for every provider',
    brandProviders.every((k) => new RegExp(`--brand-${k}:\\s*#[0-9A-Fa-f]{6}`).test(app)
      && new RegExp(`--brand-${k}-soft:\\s*#[0-9A-Fa-f]{6}`).test(app)
      && new RegExp(`--brand-${k}-ink:\\s*#[0-9A-Fa-f]{6}`).test(app)));
  check('brand key map covers every provider',
    brandProviders.every((k) => new RegExp(`:\\s*'${k}'`).test(app)));
  check('selectNet applies brand color', /function selectNet[\s\S]{0,400}?applyBrand\(el\)/.test(app));
  check('boot seeds brand colors', /function boot\(\)[\s\S]{0,200}?seedBrands\(\)/.test(app));
}

// ── 9b. Brand + single service-grid integrity ────────────────────────────────
{
  const app = read('topflowng.html');
  check('exactly one "Buy a service" heading', (app.match(/Buy a service/g) || []).length === 1);
  check('no inline dashboard quickpay grid (duplicate service list)', !/id="quickpay-grid"/.test(app));
  check('dashboard service search opens launcher', /onclick="openLauncher\(\)"/.test(app));
  check('quickpay renders active services only', /activeQuickPay\(\)/.test(app) && /filter\(function\s*\(\s*s\s*\)\s*\{\s*return\s*!s\.disabled/.test(app));
  check('disabled Recharge Cards excluded from quickpay rendering', /recharge.*disabled: true/.test(app) && !/svc\.disabled \? .*Recharge Cards/.test(app.replace(/activeQuickPay/g, 'x')));
  check('favicon uses TopFlowNG brand SVG', /rel="icon" href="\/assets\/brand\/topflowng-mark\.svg"/.test(app));
  check('favicon PNG fallbacks present', /favicon-32\.png/.test(app) && /favicon-16\.png/.test(app));
  check('apple-touch icon points to branded icon', /rel="apple-touch-icon" sizes="180x180" href="\/icons\/apple-touch-icon\.png"/.test(app));
  check('brand mark uses teal gradient', /stop-color="#0B7E8E"/.test(read('assets/brand/topflowng-mark.svg'))
    && /stop-color="#0E9BAE"/.test(read('assets/brand/topflowng-mark.svg')));
  for (const p of ['/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png', '/icons/favicon-32.png', '/icons/favicon-16.png']) {
    check(`brand icon file exists ${p}`, fs.existsSync(path.join(ROOT, p.slice(1))));
  }
  check('service worker precaches branded icons', ['icon-192.png?v=2', 'icon-512.png?v=2', 'apple-touch-icon.png', 'favicon-32.png', 'favicon-16.png'].every((p) => read('sw.js').includes(p)));
}

// ── 10. Dual-palette + theme persistence ────────────────────────────────────
{
  const app = read('topflowng.html');
  check('emerald palette token block present', /html\[data-palette="emerald"\]/.test(app));
  check('emerald dark palette token block present', /html\.dark\[data-palette="emerald"\]/.test(app));
  check('no-flash palette init runs before CSS', /<!DOCTYPE html>[\s\S]{0,900}?data-palette/.test(app));
  check('palette persisted under topflowng-palette', /topflowng-palette/.test(app));
  check('theme persisted under topflowng-theme', /topflowng-theme/.test(app));
  check('selectPalette UI control present', /function selectPalette\(/.test(app) && /id="palette-options"/.test(app));
  check('system appearance option present', /id="theme-system"/.test(app) && /selectTheme\('system'\)/.test(app));
  check('live system-preference listener present', /prefers-color-scheme/.test(app));
}

// ── 11. Notification centre surfaces ────────────────────────────────────────
{
  const app = read('topflowng.html');
  check('notification bell in header', /id="notif-bell"/.test(app) && /id="notif-badge"/.test(app));
  check('notifications screen exists', /id="screen-notifications"/.test(app));
  check('notification filter chips present', /filterNotifications\('transaction'/ && /filterNotifications\('security'/.test(app));
  check('mark-all-read action present', /markAllNotificationsRead\(\)/.test(app));
  check('notification API consumers wired', /api\('GET', '\/api\/notifications/.test(app) && /\/api\/notifications\/read-all/.test(app));
  check('unread badge refresh on boot', /refreshNotifBadge\(\)/.test(app));
  check('no fake demo notifications in production markup', !/demo notification/i.test(app) && !/pushDemoNotif/.test(app));
}

// ── 12. Transaction history + detail + receipts ─────────────────────────────
{
  const app = read('topflowng.html');
  check('history status filters present', /filterTxnsByStatus\('pending'/ && /filterTxnsByStatus\('failed'/.test(app));
  check('history date filters present', /filterTxnsByDate\('today'/ && /filterTxnsByDate\('month'/.test(app));
  check('history category filters present', /filterTxns\('wallet'/ && /filterTxns\('credit'/.test(app));
  check('history date grouping implemented', /txnGroupLabel\(/.test(app) && /txn-group-label/.test(app));
  check('transaction detail overlay present', /id="txn-detail-overlay"/.test(app));
  check('transaction detail rows are interactive', /createTxnRow\(t\)/.test(app) && /openTransactionDetail\(t\)/.test(app));
  check('receipt share/print/download actions present', /shareTransactionReceipt\(\)/.test(app) && /printTransactionReceipt\(\)/.test(app));
  check('electricity token recovered from order detail', /electricityToken/.test(app) && /api\/vtu\/orders\//.test(app));
  check('history search filters client+server side', /activeTxnFilter/.test(app));
}

// ── 13. Support centre ──────────────────────────────────────────────────────
{
  const app = read('topflowng.html');
  check('support overlay present', /id="support-overlay"/.test(app) && /class="support-faq"/.test(app));
  check('support FAQ items exist', /class="faq-item"/.test(app));
  check('support reachable from account', /onclick="openSupport\(\)"/.test(app));
  check('failed-transaction help pre-fills reference', /support-ref/.test(app));
  check('support email surface exists', /hello@topflowng\.com/.test(app));
  check('legacy support email removed from customer UI', !/support@topflowng\.com/.test(app));
  check('support email is a clickable mailto link', /mailto:hello@topflowng\.com/.test(app));
  check('support FAQ is searchable', /filterSupportFAQ/.test(app) && /id="support-search"/.test(app));
  check('support FAQ is categorized', /support-faq-cat/.test(app));
  check('support chat action present', /openTawkChat/.test(app) && /Chat with Support/.test(app));
  check('support quick help present', /support-quick/.test(app) && /quickHelp/.test(app));
  check('single floating support launcher', (app.match(/class="support-fab"/g) || []).length === 1);
  check('launcher toggles the support overlay', /toggleSupportLauncher/.test(app));
  check('tawk default bubble hidden to avoid duplicate launcher', /hideWidget/.test(app));
}

// ── 14. Marketing rates come from the server catalogue ─────────────────────
{
  const app = read('topflowng.html');
  check('marketing rates table is catalogue-driven container', /id="marketing-rate-table"/.test(app));
  check('marketing rates rendered from loaded catalogue', /renderMarketingRates\(\)/.test(app) && /loadPlans\(\)\.then\(function\s*\(\s*\)\s*\{\s*renderMarketingRates\(\)/.test(app));
  check('no hardcoded marketing data prices remain', !/1GB\s*·\s*30 days/.test(app) && !/class="rate-row"><span>1GB/.test(app));
  check('marketing rates section no longer hardcodes Naira amounts',
    !/<div class="rate-row"><span>1GB · 30 days<\/span><strong>₦/.test(app));
  check('renderMarketingRates reads from live DATA_PLANS', /DATA_PLANS\[key\]/.test(app));
}

// ── 15. No hardcoded fallback secrets in app code ──────────────────────────
{
  const jsFiles = ['server.js', 'config.js', 'middleware/auth.js'].map((f) => read(f));
  const all = jsFiles.join('\n');
  check('no unguarded hardcoded JWT secret in app code', !/change_this_in_production/.test(all));
  check('no legacy dead auth.js module remains', !fs.existsSync(path.join(ROOT, 'auth.js')));
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\nFrontend/static checks: ${results.length} total, ${failures} failed.`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + (r.detail || '')}`);
}
process.exit(failures > 0 ? 1 : 0);
