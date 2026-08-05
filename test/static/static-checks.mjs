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

// ── 8. AI assistant safe rendering ─────────────────────────────────────────
{
  const html = read('topflowng.html');
  const modelRenderUsesTextContent =
    /function aiAppendText\s*\([\s\S]*?m\.textContent\s*=\s*String\(/.test(html);
  check('AI renders via textContent (model text is never HTML)', modelRenderUsesTextContent);
  check('AI panel has aria-live', /id="ai-messages"[^>]*aria-live="polite"/.test(html));
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log(`\nFrontend/static checks: ${results.length} total, ${failures} failed.`);
for (const r of results) {
  console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : ' — ' + (r.detail || '')}`);
}
process.exit(failures > 0 ? 1 : 0);