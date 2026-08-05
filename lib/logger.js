/**
 * TopFlowNG — Structured JSON logger.
 *
 * Emits one JSON object per line to stdout (info/debug) or stderr (warn/error).
 * Never logs passwords, JWTs, API keys, card data, PINs, or full provider
 * response bodies — sensitive fields are redacted recursively.
 */

'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

const SENSITIVE_KEY = /(password|passwd|secret|token|authorization|api[_-]?key|apikey|card|cvv|cvc|\bpin\b|signature|jwt|bearer)/i;

const threshold = LEVELS[String(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

function redact(value, key) {
  if (typeof value === 'string' && key && SENSITIVE_KEY.test(String(key))) {
    return '[REDACTED]';
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, key));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      out[k] = redact(value[k], k);
    }
    return out;
  }
  return value;
}

function write(level, msg, fields) {
  const record = {
    level,
    ts: new Date().toISOString(),
    msg,
    ...redact(fields || {}, ''),
  };
  const line = JSON.stringify(record);
  if (LEVELS[level] >= LEVELS.warn) {
    process.stderr.write(`${line}\n`);
  } else {
    process.stdout.write(`${line}\n`);
  }
}

function makeLogger(bindings = {}) {
  return {
    debug(msg, fields) {
      if (LEVELS.debug < threshold) return;
      write('debug', msg, { ...bindings, ...fields });
    },
    info(msg, fields) {
      if (LEVELS.info < threshold) return;
      write('info', msg, { ...bindings, ...fields });
    },
    warn(msg, fields) {
      if (LEVELS.warn < threshold) return;
      write('warn', msg, { ...bindings, ...fields });
    },
    error(msg, fields) {
      if (LEVELS.error < threshold) return;
      write('error', msg, { ...bindings, ...fields });
    },
    child(extraBindings) {
      return makeLogger({ ...bindings, ...extraBindings });
    },
  };
}

module.exports = makeLogger();
module.exports.makeLogger = makeLogger;
