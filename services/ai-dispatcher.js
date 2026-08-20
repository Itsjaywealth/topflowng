/**
 * TopFlowNG — Unified AI chat dispatcher (OpenAI + OpenRouter).
 *
 * Tries providers in config order (`ai.providerOrder`). The primary provider
 * is used for the primary model; if it fails (network/upstream), the same model
 * is retried through the next provider when the model is available there, then
 * the configured fallback model is attempted. Safety contract is inherited from
 * the per-provider clients: normalized envelope out, no key/prompt leak.
 */

'use strict';

const config = require('../config');
const openrouter = require('./openrouter');
const openai = require('./openai');

const PROVIDERS = [
  { name: 'openai', client: openai, key: () => config.ai.openAiApiKey, model: () => config.ai.openAiPrimaryModel },
  { name: 'openrouter', client: openrouter, key: () => config.ai.openRouterApiKey, model: () => config.ai.openRouterPrimaryModel },
];

function activeProviders() {
  const order = (config.ai.providerOrder || 'openrouter')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const byName = {};
  for (const p of PROVIDERS) byName[p.name] = p;

  // Resolve the requested order, defaulting to configured providers in a sane
  // order when the env value is empty or references unknown providers.
  const wanted = order.filter((name) => byName[name]);
  const known = PROVIDERS.filter((p) => p.key());
  const resolved = wanted.length ? wanted.map((name) => byName[name]) : known;
  const present = new Set(resolved.map((p) => p.name));

  // Never drop a configured provider that was omitted from the order list.
  for (const p of known) {
    if (!present.has(p.name)) resolved.push(p);
  }
  return resolved;
}

function providerForModel(model) {
  const primaryModel = config.ai.primaryModel;
  const fallbackModel = config.ai.fallbackModel;
  const openAiModel = config.ai.openAiPrimaryModel;
  const openAiFallback = config.ai.openAiFallbackModel;

  // Route by model identity so tools + system prompt behave consistently.
  if (model === openAiModel || model === openAiFallback) return 'openai';
  if (model === primaryModel || model === fallbackModel) return 'openrouter';
  return null; // allow-listed extra model: try providers in order
}

async function chatCompletion({ model, messages, tools, maxTokens, timeoutMs, toolChoice }) {
  const providers = activeProviders();
  if (!providers.length) {
    throw openrouter.createUpstreamError('unconfigured', model);
  }

  const fixed = providerForModel(model);
  const ordered = fixed
    ? providers.filter((p) => p.name === fixed)
    : providers;

  let lastError = null;
  for (const provider of ordered) {
    if (!provider.key()) {
      lastError = provider.client.createUpstreamError('unconfigured', model);
      continue;
    }
    try {
      return await provider.client.chatCompletion({ model, messages, tools, maxTokens, timeoutMs, toolChoice });
    } catch (err) {
      lastError = err;
      // Timeouts and upstream failures move on to the next provider; an
      // explicit unconfigured state is terminal for that provider only.
      if (err && (err.code === 'AI_TIMEOUT' || err.code === 'AI_UPSTREAM_ERROR')) continue;
      if (err && err.code !== 'AI_UNCONFIGURED') throw err;
    }
  }

  throw lastError || openrouter.createUpstreamError('upstream', model);
}

module.exports = { chatCompletion, activeProviders, providerForModel };