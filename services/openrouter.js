/**
 * TopFlowNG — Minimal OpenRouter HTTP client.
 *
 * The ONLY module that contacts the OpenRouter API. Isolated so tests can
 * replace this one file with an in-memory mock (guaranteeing zero real
 * provider calls) while exercising the full AI orchestration in services/ai.js.
 *
 * Safety rules:
 * - Uses the shared axios instance; the API key is only ever sent in the
 *   Authorization header of the outbound request — never logged, never stored
 *   on the response, never exposed to callers.
 * - Callers receive a small normalized envelope: `{ content, model, usage }`.
 *   The raw upstream response (including any echo of the prompt or system
 *   content) is discarded here and never propagated.
 */

'use strict';

const axios = require('axios');
const config = require('../config');

/**
 * Single chat-completion request to OpenRouter.
 *
 * @param {Object} options
 * @param {string} options.model        - model ID (already allow-listed)
 * @param {Array<{role:string,content:string}>} options.messages - system+user+tool history
 * @param {Array<Object>} [options.tools] - optional tool schemas (allow-listed)
 * @param {number} [options.maxTokens]  - max output tokens
 * @param {number} [options.timeoutMs]  - request timeout
 * @returns {Promise<{content:string,model:string,usage:Object|null}>}
 *   Resolves with normalized safe output. Rejects with an AiUpstreamError whose
 *   message is a generic description — the upstream body is never surfaced.
 */
async function chatCompletion({ model, messages, tools, maxTokens, timeoutMs }) {
  const cfg = config.ai;
  if (!cfg.openRouterApiKey) {
    throw createUpstreamError('unconfigured', model);
  }
  const body = {
    model,
    messages,
    max_tokens: maxTokens != null ? maxTokens : cfg.maxOutputTokens,
  };
  if (tools && tools.length) body.tools = tools;

  let response;
  try {
    response = await axios.post(
      `${cfg.baseUrl}/chat/completions`,
      body,
      {
        timeout: timeoutMs != null ? timeoutMs : cfg.timeoutMs,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.openRouterApiKey}`,
          ...(cfg.appName ? { 'X-Title': cfg.appName } : {}),
          ...(cfg.appUrl ? { 'X-App-Url': cfg.appUrl } : {}),
          ...(cfg.appUrl ? { Referer: cfg.appUrl } : {}),
        },
      }
    );
  } catch (err) {
    // Never leak upstream error bodies, statuses, or the API key.
    const kind = err.code === 'ECONNABORTED' ? 'timeout' : 'upstream';
    throw createUpstreamError(kind, model);
  }

  const data = response && response.data ? response.data : null;
  const choice = data && Array.isArray(data.choices) ? data.choices[0] : null;
  const message = choice && choice.message ? choice.message : null;

  const content = extractContent(message);

  const usage = data && data.usage ? sanitizeUsage(data.usage) : null;

  return {
    content,
    model: String(message && message.model ? message.model : model),
    usage,
  };
}

// Tool-call support: OpenRouter returns structured `tool_calls`. The AI service
// decides whether to expose them; this client just carries them through.
function extractContent(message) {
  if (message && typeof message.content === 'string' && message.content.length) {
    return { kind: 'text', text: message.content };
  }
  if (message && Array.isArray(message.tool_calls) && message.tool_calls.length) {
    return {
      kind: 'tool_calls',
      toolCalls: message.tool_calls.map((tc) => ({
        id: String(tc.id || ''),
        name: String(tc.function && tc.function.name ? tc.function.name : ''),
        arguments: safeParseJson(tc.function && tc.function.arguments),
      })),
    };
  }
  return { kind: 'text', text: '' };
}

function safeParseJson(raw) {
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function sanitizeUsage(usage) {
  // Only numeric token counts are safe usage metadata. Never echo the model's
  // raw cost payload, ids, or anything provider-specific.
  const out = {};
  if (typeof usage.prompt_tokens === 'number') out.prompt_tokens = usage.prompt_tokens;
  if (typeof usage.completion_tokens === 'number') out.completion_tokens = usage.completion_tokens;
  if (typeof usage.total_tokens === 'number') out.total_tokens = usage.total_tokens;
  return Object.keys(out).length ? out : null;
}

function createUpstreamError(kind, model) {
  const messages = {
    timeout: 'The AI assistant timed out.',
    unconfigured: 'The AI assistant is not configured yet.',
  };
  const err = new Error(messages[kind] || 'The AI assistant could not be reached right now.');
  err.code = kind === 'unconfigured' ? 'AI_UNCONFIGURED'
    : kind === 'timeout' ? 'AI_TIMEOUT'
      : 'AI_UPSTREAM_ERROR';
  err.kind = kind;
  err.model = model;
  return err;
}

module.exports = { chatCompletion, createUpstreamError };
