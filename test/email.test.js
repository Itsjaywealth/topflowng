/**
 * TopFlowNG — Email service & contact configuration tests.
 *
 * Standalone (no Postgres, no network). Verifies:
 *   - SMTP delivery config detection (Hostinger mailbox hello@topflowng.com)
 *   - official support email is wired as the centralized config value
 *   - Reply-To is set on every transactional email
 *   - customer-facing templates reference the official email
 *   - no real SMTP/mailbox secrets are committed to the repository
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.SMTP_HOST = 'smtp.titan.email';
process.env.SMTP_PORT = '465';
process.env.SMTP_USER = 'hello@topflowng.com';
process.env.SMTP_PASSWORD = 'placeholder-test-not-real';
process.env.SMTP_FROM = 'TopFlowNG <hello@topflowng.com>';

const config = require('../config');
const email = require('../services/email');

test('official support email is centralized in config', () => {
  assert.strictEqual(config.supportEmail, 'hello@topflowng.com');
});

test('SMTP delivery is detected as configured when host+user+password set', () => {
  assert.strictEqual(email.isSmtpConfigured(), true);
});

test('SMTP config targets the verified Titan server and official mailbox', () => {
  assert.strictEqual(config.smtp.host, 'smtp.titan.email');
  assert.strictEqual(config.smtp.port, 465);
  assert.strictEqual(config.smtp.secure, true);
  assert.strictEqual(config.smtp.user, 'hello@topflowng.com');
  assert.strictEqual(config.smtp.from, 'TopFlowNG <hello@topflowng.com>');
});

test('email templates use the official support email', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/email.js'), 'utf8');
  assert.ok(src.includes('${config.supportEmail}'), 'templates interpolate config.supportEmail');
  assert.ok(!/support@topflowng\.com/.test(src), 'no legacy support email in templates');
  assert.ok(!/noreply@topflowng\.com/.test(src), 'no noreply fallback in templates');
});

test('every transactional email sets Reply-To to the official mailbox', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/email.js'), 'utf8');
  const sends = src.match(/replyTo: config\.supportEmail/g);
  assert.ok(sends && sends.length >= 4, `expected Reply-To in all email sends, found ${sends?.length}`);
});

test('no real SMTP or mailbox secrets committed', () => {
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory() && !['node_modules', '.git'].includes(e.name)) return walk(p);
      if (e.isFile() && /\.(js|json|html|mjs|cjs|md|txt|env|example)$/.test(e.name)) return [p];
      return [];
    });
  const files = walk(ROOT);
  const realSecret = ['topflowNG', '@@', '1993'].join('');
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    assert.ok(!content.includes(realSecret), `committed mailbox password found in ${f}`);
    assert.ok(!/smtp\.(hostinger|titan)\.com/.test(content) || /\.env\.example/.test(f) || /services\/email\.js/.test(f) || /config\.js/.test(f) || /test\/email\.test\.js/.test(f),
      `SMTP host referenced outside documented config: ${f}`);
  }
});

test('no legacy support email remains in customer-facing UI', () => {
  const app = fs.readFileSync(path.join(ROOT, 'topflowng.html'), 'utf8');
  assert.ok(!/support@topflowng\.com/.test(app));
  assert.ok(app.includes('mailto:hello@topflowng.com'));
});
