'use strict';

/**
 * TopFlowNG — TOTP two-factor authentication (RFC 6238, SHA-1, 6 digits, 30s).
 *
 * Implemented in-house to avoid a runtime dependency on this path; pinned
 * against RFC test vectors in test/totp.test.js. Secrets are stored
 * AES-256-GCM encrypted at rest under config.auth.totpKey.
 */

const crypto = require('crypto');
const config = require('../config');

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | BASE32_ALPHABET.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

// Derive the at-rest encryption key once (TOTP_ENCRYPTION_KEY or derived from
// the JWT secret — both server-only secrets).
let _key = null;
function encryptionKey() {
  if (!_key) {
    const material = config.auth.totpEncryptionKey || config.jwt.secret;
    _key = crypto.createHash('sha256').update(`topflow-totp:${material}`).digest();
  }
  return _key;
}

function encryptSecret(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function decryptSecret(stored) {
  try {
    const [ivB64, tagB64, dataB64] = String(stored).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function codeFor(secretBase32, counter) {
  const key = base32Decode(secretBase32);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', key).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const bin = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/**
 * Verify a 6-digit code against the current ±`window` time steps.
 * Comparison is constant-time per candidate step.
 */
function verifyTotp(secretBase32, code, { window = 1, nowMs = Date.now() } = {}) {
  const expected = String(code || '').trim();
  if (!/^\d{6}$/.test(expected)) return false;
  const counter = Math.floor(nowMs / 30_000);
  for (let drift = -window; drift <= window; drift++) {
    const candidate = codeFor(secretBase32, counter + drift);
    const a = Buffer.from(candidate);
    const b = Buffer.from(expected);
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) return true;
  }
  return false;
}

function otpauthUrl(email, secretBase32) {
  const label = encodeURIComponent(`TopFlowNG:${email}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=TopFlowNG&algorithm=SHA1&digits=6&period=30`;
}

module.exports = {
  generateSecret,
  encryptSecret,
  decryptSecret,
  verifyTotp,
  otpauthUrl,
  base32Encode,
  base32Decode,
};
