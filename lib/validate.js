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

module.exports = { normalizeEmail, isValidEmail, isValidPhone };