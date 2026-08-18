'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { normalizeVtpassResponse, buildRequestId, VT_PENDING_CODES, VT_FAILURE_CODES, PRODUCT_MAP } = require('../services/vtpass');

describe('normalizeVtpassResponse', () => {
  test('000 + delivered = success', () => {
    const out = normalizeVtpassResponse({
      code: '000',
      response_description: 'TRANSACTION SUCCESSFUL',
      content: { transactions: { status: 'delivered' } },
    });
    assert.strictEqual(out.outcome, 'success');
    assert.strictEqual(out.statusCode, 0);
  });

  test('000 + initiated = pending', () => {
    const out = normalizeVtpassResponse({
      code: '000',
      content: { transactions: { status: 'initiated' } },
    });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('000 + pending = pending', () => {
    const out = normalizeVtpassResponse({
      code: '000',
      content: { transactions: { status: 'pending' } },
    });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('000 + missing inner status = pending', () => {
    const out = normalizeVtpassResponse({ code: '000' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('000 with no content = pending', () => {
    const out = normalizeVtpassResponse({ code: '000', response_description: 'Successful' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('016 TRANSACTION FAILED', () => {
    const out = normalizeVtpassResponse({ code: '016', response_description: 'TRANSACTION FAILED' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('091 TRANSACTION NOT PROCESSED', () => {
    const out = normalizeVtpassResponse({ code: '091' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('087 INVALID CREDENTIALS', () => {
    const out = normalizeVtpassResponse({ code: '087', message: 'INVALID CREDENTIALS' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('028 PRODUCT NOT WHITELISTED', () => {
    const out = normalizeVtpassResponse({ code: '028', response_description: 'PRODUCT IS NOT WHITELISTED ON YOUR ACCOUNT' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('040 TRANSACTION REVERSAL', () => {
    const out = normalizeVtpassResponse({ code: '040' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('083 SYSTEM ERROR', () => {
    const out = normalizeVtpassResponse({ code: '083', content: { errors: 'OOPS!!! SYSTEM ERROR' } });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('018 LOW WALLET BALANCE', () => {
    const out = normalizeVtpassResponse({ code: '018' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('010 VARIATION CODE DOES NOT EXIST', () => {
    const out = normalizeVtpassResponse({ code: '010' });
    assert.strictEqual(out.outcome, 'failed');
  });

  test('014 REQUEST ID ALREADY EXIST = pending (requery needed)', () => {
    const out = normalizeVtpassResponse({ code: '014' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('099 TRANSACTION IS PROCESSING = pending', () => {
    const out = normalizeVtpassResponse({ code: '099' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('089 REQUEST IS PROCESSING = pending', () => {
    const out = normalizeVtpassResponse({ code: '089' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('001 TRANSACTION QUERY = pending', () => {
    const out = normalizeVtpassResponse({ code: '001' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('unknown code defaults to pending', () => {
    const out = normalizeVtpassResponse({ code: '999', response_description: 'UNKNOWN' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('null code defaults to pending', () => {
    const out = normalizeVtpassResponse({ response_description: 'No code' });
    assert.strictEqual(out.outcome, 'pending');
  });

  test('extracts orderId from transactionId', () => {
    const out = normalizeVtpassResponse({
      code: '000',
      content: { transactions: { status: 'delivered', transactionId: 'TX-12345' } },
    });
    assert.strictEqual(out.orderId, 'TX-12345');
  });

  test('skips zero/empty orderId', () => {
    const zero = normalizeVtpassResponse({ code: '000', content: { transactions: { status: 'delivered', transactionId: '0' } } });
    assert.strictEqual(zero.orderId, null);

    const empty = normalizeVtpassResponse({ code: '000', content: { transactions: { status: 'delivered', transactionId: '' } } });
    assert.strictEqual(empty.orderId, null);
  });

  test('extracts token from purchased_code', () => {
    const out = normalizeVtpassResponse({
      code: '000',
      content: { transactions: { status: 'delivered' } },
      purchased_code: 'ELEC-TOKEN-001',
    });
    assert.strictEqual(out.token, 'ELEC-TOKEN-001');
    assert.strictEqual(out.purchasedCode, 'ELEC-TOKEN-001');
  });

  test('extracts token from content.transactions.purchased_code', () => {
    const out = normalizeVtpassResponse({
      code: '000',
      content: { transactions: { status: 'delivered', purchased_code: 'PIN-ABCD-1234' } },
    });
    assert.strictEqual(out.token, 'PIN-ABCD-1234');
  });

  test('pipe format: 000|TRANSACTION SUCCESSFUL', () => {
    const out = normalizeVtpassResponse('000|TRANSACTION SUCCESSFUL');
    assert.strictEqual(out.description, 'TRANSACTION SUCCESSFUL');
  });

  test('pipe format: 016|TRANSACTION FAILED', () => {
    const out = normalizeVtpassResponse('016|TRANSACTION FAILED');
    assert.strictEqual(out.outcome, 'failed');
  });

  test('handles JSON string input', () => {
    const out = normalizeVtpassResponse(JSON.stringify({ code: '000', response_description: 'OK', content: { transactions: { status: 'delivered' } } }));
    assert.strictEqual(out.outcome, 'success');
  });

  test('handles null/undefined input gracefully', () => {
    const n = normalizeVtpassResponse(null);
    assert.strictEqual(n.outcome, 'pending');

    const u = normalizeVtpassResponse(undefined);
    assert.strictEqual(u.outcome, 'pending');
  });

  test('sandbox success response shape', () => {
    const sandboxResponse = {
      code: '000',
      response_description: 'TRANSACTION SUCCESSFUL',
      content: {
        transactions: {
          status: 'delivered',
          product_name: 'MTN Airtime VTU',
          unique_element: '08031234567',
          unit_price: '100',
          quantity: 1,
          transactionId: 'SANDBOX-TX-001',
          commission: 3.5,
        },
      },
      requestId: 'SANDBOXTEST01',
      amount: 100,
    };
    const out = normalizeVtpassResponse(sandboxResponse);
    assert.strictEqual(out.outcome, 'success');
    assert.strictEqual(out.orderId, 'SANDBOX-TX-001');
    assert.strictEqual(out.description, 'TRANSACTION SUCCESSFUL');
  });

  test('sets remark from message field', () => {
    const out = normalizeVtpassResponse({ code: '016', message: 'Service declined', response_description: 'TRANSACTION FAILED' });
    assert.strictEqual(out.remark, 'Service declined');
  });

  test('falls back remark to description', () => {
    const out = normalizeVtpassResponse({ code: '016', response_description: 'TRANSACTION FAILED' });
    assert.strictEqual(out.remark, 'TRANSACTION FAILED');
  });
});

describe('buildRequestId', () => {
  test('returns a string starting with today YYYYMMDDHH', () => {
    const id = buildRequestId();
    assert(typeof id === 'string');
    assert(id.length > 12);
    const prefix = id.slice(0, 10);
    const today = new Date(Date.now() + 60 * 60 * 1000);
    const p = (n) => String(n).padStart(2, '0');
    const expected = `${today.getUTCFullYear()}${p(today.getUTCMonth() + 1)}${p(today.getUTCDate())}${p(today.getUTCHours())}`;
    assert.strictEqual(prefix, expected);
  });

  test('generates unique IDs', () => {
    const ids = new Set();
    for (let i = 0; i < 100; i++) ids.add(buildRequestId());
    assert.strictEqual(ids.size, 100);
  });
});

describe('VT_PENDING_CODES', () => {
  test('contains documented pending codes', () => {
    for (const code of ['001', '014', '089', '099']) {
      assert.ok(VT_PENDING_CODES.has(code), `${code} should be pending`);
    }
  });
});

describe('VT_FAILURE_CODES', () => {
  test('contains documented failure codes', () => {
    for (const code of ['010', '011', '016', '018', '028', '040', '083', '087', '091']) {
      assert.ok(VT_FAILURE_CODES.has(code), `${code} should be failure`);
    }
  });

  test('does not include pending codes', () => {
    for (const code of VT_PENDING_CODES) {
      assert.ok(!VT_FAILURE_CODES.has(code), `${code} should not be in failure codes`);
    }
  });
});

describe('PRODUCT_MAP', () => {
  test('has data plans for all networks', () => {
    for (const net of ['MTN', 'GLO', 'AIRTEL', '9MOBILE']) {
      assert.ok(PRODUCT_MAP.data[net], `Missing data plans for ${net}`);
      assert.ok(Object.keys(PRODUCT_MAP.data[net]).length > 0);
    }
  });

  test('has cable packages for DSTV, GOTV, STARTIMES', () => {
    for (const provider of ['DSTV', 'GOTV', 'STARTIMES']) {
      assert.ok(PRODUCT_MAP.cable[provider], `Missing cable packages for ${provider}`);
      assert.ok(Object.keys(PRODUCT_MAP.cable[provider]).length > 0);
    }
  });

  test('has WAEC exam entry', () => {
    assert.ok(PRODUCT_MAP.exam.WAEC);
    assert.strictEqual(PRODUCT_MAP.exam.WAEC.serviceID, 'waec');
  });
});

/**
 * The structural invariant of the product catalogue: anything the customer UI
 * can see and select MUST resolve to a provider serviceID + variation code.
 * An enabled-but-unmapped product would take the customer through a whole
 * purchase flow only to fail — or, worse, ship a request built from a guessed
 * variation code. These tests fail the build if the two lists ever drift.
 */
describe('catalog ↔ provider mapping completeness', () => {
  const vtpass = require('../services/vtpass');
  const pricing = require('../services/pricing');

  test('every listed data plan has a serviceID and variation code', () => {
    for (const [network, plans] of Object.entries(pricing.DATA_PLANS)) {
      assert.ok(vtpass.DATA_SERVICE[network], `no data serviceID for ${network}`);
      for (const plan of plans) {
        assert.ok(
          PRODUCT_MAP.data[network] && PRODUCT_MAP.data[network][plan.code],
          `data plan ${plan.code} is listed for sale but has no provider mapping`,
        );
      }
    }
  });

  test('every listed cable package has a serviceID and variation code', () => {
    for (const [provider, plans] of Object.entries(pricing.CABLE_PLANS)) {
      assert.ok(vtpass.CABLE_SERVICE[provider], `no cable serviceID for ${provider}`);
      for (const plan of plans) {
        assert.ok(
          PRODUCT_MAP.cable[provider] && PRODUCT_MAP.cable[provider][plan.code],
          `cable package ${plan.code} is listed for sale but has no provider mapping`,
        );
      }
    }
  });

  test('every listed electricity disco has a serviceID', () => {
    for (const disco of pricing.ELECTRICITY_DISCOS) {
      assert.ok(
        vtpass.DISCO_SERVICE[disco.code],
        `disco ${disco.code} is listed for sale but has no provider mapping`,
      );
    }
  });

  test('every enabled exam body has a provider mapping', () => {
    for (const body of pricing.ENABLED_EXAM_BODIES) {
      assert.ok(
        PRODUCT_MAP.exam[body],
        `exam body ${body} is enabled but has no provider mapping`,
      );
    }
  });

  test('no disabled exam body is priced or mapped as purchasable', () => {
    for (const [code, product] of Object.entries(pricing.EXAM_PRODUCTS)) {
      if (product.enabled) continue;
      assert.strictEqual(pricing.EXAM_PRICES[code], undefined, `${code} must not be priced`);
      assert.strictEqual(pricing.findExamPrice(code), null, `${code} must not resolve a price`);
      assert.ok(!PRODUCT_MAP.exam[code], `${code} must not be mapped as purchasable`);
    }
  });

  test('recharge-card PINs stay unmapped until their serviceIDs are verified', () => {
    assert.strictEqual(
      Object.keys(PRODUCT_MAP.recharge || {}).length, 0,
      'recharge PIN serviceIDs are unverified and must not be mapped',
    );
  });

  test('productFor refuses a disabled exam body rather than guessing', () => {
    assert.throws(
      () => vtpass.productFor('exam-pin', { examBody: 'NECO', quantity: 1 }),
      /not available/i,
    );
  });
});