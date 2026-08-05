/**
 * TopFlowNG — AI assistant API.
 *
 * POST /api/ai/chat
 *   auth: required (authMiddleware)
 *   rate: per-user (aiLimiter)
 *   body: { message, model? }   (role is fixed to 'user' server-side)
 *
 * Returns `{ text, model, usage?, toolUsed? }`. Errors are always
 * `{ error: string }` with generic text — upstream provider bodies never leak.
 */

'use strict';

const express = require('express');
const rateLimit = require('express-rate-limit');

const config = require('../config');
const { authMiddleware } = require('../middleware/auth');
const { sendError } = require('../lib/errors');
const logger = require('../lib/logger');
const ai = require('../services/ai');

const router = express.Router();

// Per-user AI rate limiter. Runs AFTER authMiddleware so req.user is set.
const aiLimiter = rateLimit({
  windowMs: config.ai.requestLimitWindowMs,
  max: config.ai.requestLimitMax,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `ai:${req.user ? req.user.id : 'anon'}`,
  message: { error: 'Too many AI requests. Please try again later.' },
});

// Allowed role/message schema. The client can only ever be `user`; anything else
// is rejected rather than trusted.
function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { error: 'Request body must be a JSON object.' };
  }
  if (body.role !== undefined && body.role !== 'user') {
    return { error: 'Only the role "user" is allowed.' };
  }
  const { message, model } = body;
  if (typeof message !== 'string' || !message.trim()) {
    return { error: 'message is required and must be a non-empty string.' };
  }
  if (message.length > config.ai.maxInputLength) {
    return { error: `message is too long (max ${config.ai.maxInputLength} characters).` };
  }
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || !model.trim()) {
      return { error: 'model must be a string.' };
    }
    if (model.length > 200) return { error: 'model is too long.' };
  }
  return { message, model };
}

router.post('/chat', authMiddleware, aiLimiter, async (req, res) => {
  const v = validateChatBody(req.body);
  if (v.error) return sendError(res, 400, v.error);

  try {
    const result = await ai.runChat({
      userId: req.user.id,
      message: v.message,
      requestedModel: v.model,
    });
    // usage is only the safe token-count subset produced by the AI layer.
    return res.json({
      text: result.text,
      model: result.model,
      usage: result.usage && (result.usage.total_tokens || result.usage.prompt_tokens || result.usage.completion_tokens)
        ? result.usage
        : null,
      toolUsed: Boolean(result.toolUsed),
    });
  } catch (err) {
    // Map known statuses; everything else is a generic 502 that never echoes
    // an upstream body, prompt, token, or key.
    let status = (err && err.aiStatus) || 502;
    let message = (err && err.aiMessage) || 'The AI assistant could not be reached right now.';
    if ((err && err.code === 'AI_UNCONFIGURED')) {
      status = 503;
      message = 'The AI assistant is not configured yet.';
    }
    if (status >= 500) {
      logger.warn('AI chat error', { code: err && err.code, model: err && err.model });
    }
    return sendError(res, status, message);
  }
});

module.exports = { router, aiLimiter, validateChatBody };