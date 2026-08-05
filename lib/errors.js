/**
 * TopFlowNG — Consistent JSON errors.
 *
 * Every error response is `{ error: string }` shaped. ApiError carries an
 * optional status and extra fields (e.g. pinRequired) so existing client
 * contracts keep working.
 */

'use strict';

class ApiError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.extra = extra;
  }
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ error: message, ...extra });
}

function notFound(message = 'Not found') {
  return new ApiError(404, message);
}

function badRequest(message) {
  return new ApiError(400, message);
}

function unauthorized(message = 'Unauthorized') {
  return new ApiError(401, message);
}

function forbidden(message = 'Forbidden') {
  return new ApiError(403, message);
}

module.exports = { ApiError, sendError, notFound, badRequest, unauthorized, forbidden };
