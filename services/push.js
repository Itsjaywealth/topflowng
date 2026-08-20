'use strict';

const webPush = require('web-push');
const config = require('../config');
const logger = require('./logger');

const VAPID_PUBLIC = config.push?.vapidPublicKey || process.env.VAPID_PUBLIC_KEY || 'BCWj3Xz8Mez7hMZHA1qgjIKZsObYx66d_l28eimzTmjNx-pWN20ijeVNMCD78s0BgLBI99ls12y14r0cQPO3IUc';
const VAPID_PRIVATE = config.push?.vapidPrivateKey || process.env.VAPID_PRIVATE_KEY || 'K6MqK9Qb2cexINMta4_GX02hnOZxXssqxURUJDKkrfE';

webPush.setVapidDetails('mailto:hello@topflowng.com', VAPID_PUBLIC, VAPID_PRIVATE);

const subscriptions = new Map();

async function subscribe(userId, subscription) {
  subscriptions.set(String(userId), subscription);
  logger.info('Push subscribed', { userId });
}

async function unsubscribe(userId) {
  subscriptions.delete(String(userId));
}

async function sendPush(userId, title, body, url = '/') {
  const sub = subscriptions.get(String(userId));
  if (!sub) return;
  try {
    await webPush.sendNotification(sub, JSON.stringify({ title, body, url }));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      subscriptions.delete(String(userId));
    }
    logger.warn('Push send failed', { userId, message: err.message });
  }
}

function getVapidPublic() {
  return VAPID_PUBLIC;
}

module.exports = { subscribe, unsubscribe, sendPush, getVapidPublic };