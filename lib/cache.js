'use strict';

const config = require('../config');
const logger = require('./logger');

const REDIS_URL = process.env.REDIS_URL || null;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

let client = null;
let connected = false;

async function connect() {
  if (!REDIS_URL) return null;
  if (client && connected) return client;
  try {
    const { createClient } = require('redis');
    client = createClient({ url: REDIS_URL });
    client.on('error', (err) => {
      logger.warn('Redis client error', { message: err.message });
      connected = false;
    });
    await client.connect();
    connected = true;
    logger.info('Redis connected');
    return client;
  } catch (err) {
    logger.warn('Redis unavailable, falling back to memory', { message: err.message });
    client = null;
    return null;
  }
}

const memoryStore = new Map();

async function get(key) {
  if (REDIS_URL && connected && client) {
    try {
      const val = await client.get(key);
      return val ? JSON.parse(val) : null;
    } catch { return null; }
  }
  const entry = memoryStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    memoryStore.delete(key);
    return null;
  }
  return entry.value;
}

async function set(key, value, ttlMs = DEFAULT_TTL_MS) {
  if (REDIS_URL && connected && client) {
    try {
      await client.setEx(key, Math.ceil(ttlMs / 1000), JSON.stringify(value));
      return;
    } catch { /* fall through to memory */ }
  }
  memoryStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

async function del(key) {
  if (REDIS_URL && connected && client) {
    try { await client.del(key); return; } catch {}
  }
  memoryStore.delete(key);
}

async function close() {
  if (client && connected) {
    try { await client.quit(); } catch {}
    connected = false;
  }
}

module.exports = { connect, get, set, del, close };