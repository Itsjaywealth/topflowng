'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');

test('providers getBalance parses the live VTPass contents.balance shape', async () => {
  process.env.VTPASS_API_KEY = 'test-api-key';
  process.env.VTPASS_USERNAME = 'test-user';
  process.env.VTPASS_PASSWORD = 'test-pass';
  process.env.VTPASS_BASE_URL = 'https://vtpass.com/api';
  process.env.VTPASS_AUTH_TYPE = 'basic';
  process.env.VTPASS_TIMEOUT_MS = '15000';

  const axiosPath = require.resolve('axios', { paths: [ROOT] });
  const ax = require(axiosPath);
  const realGet = ax.get;
  ax.get = async () => ({ data: { code: 1, contents: { balance: '3706.00' } } });

  try {
    const { getBalance } = require(path.join(ROOT, 'providers/vtpass'));
    const balance = await getBalance();
    assert.strictEqual(balance, 3706);
  } finally {
    ax.get = realGet;
  }
});

test('providers getBalance still parses legacy content.transactions.balance', async () => {
  const axiosPath = require.resolve('axios', { paths: [ROOT] });
  const ax = require(axiosPath);
  const realGet = ax.get;
  ax.get = async () => ({
    data: { code: '000', content: { transactions: { balance: '1234.50' } } },
  });

  try {
    const { getBalance } = require(path.join(ROOT, 'providers/vtpass'));
    const balance = await getBalance();
    assert.strictEqual(balance, 1234.5);
  } finally {
    ax.get = realGet;
  }
});