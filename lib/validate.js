/**
 * TopFlowNG — Input validation helpers for auth flows.
 */

'use strict';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function isValidEmail(email) {
  return EMAIL_RE.test(normalizeEmail(email));
}

// Nigerian mobile numbers: 08XXXXXXXXX, 09XXXXXXXXX, 07XXXXXXXXX, +234XXXXXXXXX.
// Kept lenient so existing non-mobile formats are not rejected.
function isValidPhone(phone) {
  const p = String(phone || '').replace(/[\s()-]/g, '');
  if (!p) return false;
  if (/^0[789]\d{9}$/.test(p)) return true;
  if (/^\+?234[789]\d{9}$/.test(p)) return true;
  return /^\d{10,15}$/.test(p);
}

/**
 * Normalize a Nigerian phone to the 0XXXXXXXXXX form VTPass accepts
 * (e.g. +2348136601886 → 08136601886, 2348136601886 → 08136601886).
 * Returns '' when the input is not a recognizable Nigerian mobile number,
 * so callers can fail closed instead of sending a malformed value.
 */
function normalizeNigerianPhone(phone) {
  const p = String(phone || '').replace(/[\s()-]/g, '');
  if (!p) return '';
  if (/^0[789]\d{9}$/.test(p)) return p;
  if (/^\+?234([789]\d{9})$/.test(p)) {
    const m = /^\+?234([789]\d{9})$/.exec(p);
    return '0' + m[1];
  }
  return '';
}

module.exports = { normalizeEmail, isValidEmail, isValidPhone, normalizeNigerianPhone };