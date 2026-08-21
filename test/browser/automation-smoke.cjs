'use strict';
/* End-to-end smoke of the automation surface against the local harness. */
const http = require('http');
const crypto = require('crypto');
const events = require('../../services/events');

const BASE = 'http://127.0.0.1:3210';
const KEY = 'smoketestkey123';

function req(method, path, { body, key, token } = {}) {
  return fetch(BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(key ? { 'x-internal-key': key } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => ({})) }));
}

(async () => {
  const results = [];
  const check = (name, cond) => { results.push(`${cond ? 'PASS' : 'FAIL'} ${name}`); if (!cond) process.exitCode = 1; };

  // 1. Internal auth fails closed
  let r = await req('GET', '/api/internal/events');
  check('internal auth rejects missing key', r.status === 401);
  r = await req('GET', '/api/internal/events', { key: 'wrong' });
  check('internal auth rejects bad key', r.status === 401);

  // 2. Receiver: captures webhook deliveries for signature verification
  const received = [];
  const receiver = http.createServer((rq, rs) => {
    let data = '';
    rq.on('data', (c) => { data += c; });
    rq.on('end', () => received.push({ headers: rq.headers, body: data }));
    rs.writeHead(200); rs.end('ok');
  });
  await new Promise((res) => receiver.listen(3998, res));

  // 3. Register endpoint + receive signed test event
  r = await req('POST', '/api/internal/webhook-endpoints', {
    key: KEY,
    body: { name: 'n8n-test', url: 'http://127.0.0.1:3998/hook' },
  });
  check('endpoint created', r.status === 201 && !!r.json.secret);
  const secret = r.json.secret;
  r = await req('POST', '/api/internal/webhook-endpoints/' + r.json.endpoint.id + '/test', { key: KEY });
  check('test event emitted', r.status === 200 && !!r.json.event_id);
  await new Promise((res) => setTimeout(res, 1500));
  check('webhook delivered to receiver', received.length >= 1);
  if (received.length) {
    const d = received[0];
    check('signature header present', typeof d.headers['x-topflow-signature'] === 'string');
    check('event id header present', !!d.headers['x-topflow-event-id']);
    const okSig = events.verifySignature(secret, d.body, d.headers['x-topflow-timestamp'], d.headers['x-topflow-signature']);
    check('HMAC signature verifies with endpoint secret', okSig);
    const parsed = JSON.parse(d.body);
    check('payload has no sensitive keys', !JSON.stringify(parsed).match(/\bpin\b|password|secret|api[_-]?key|token/i));
  }

  // 4. Register a customer and exercise RAG + bizflow + support
  const stamp = Date.now();
  const reg = await req('POST', '/api/auth/register', { body: { fullName: 'Auto QA', email: `auto${stamp}@test.local`, phone: '081' + String(stamp).slice(-8), password: 'autoSecret123' } });
  check('customer registered', reg.status === 201);
  const token = reg.json.token;

  r = await req('GET', '/api/rag/transactions', { token });
  check('RAG transactions scoped + empty', r.status === 200 && Array.isArray(r.json.transactions));
  r = await req('GET', '/api/rag/transactions/TF-DOES-NOT-EXIST', { token });
  check('RAG other-customer reference → 404', r.status === 404);
  r = await req('GET', '/api/rag/services', { token });
  check('RAG services catalogue', r.status === 200 && r.json.services.length === 5);
  r = await req('GET', '/api/rag/faq', { token });
  check('RAG FAQ content', r.status === 200 && r.json.faqs.length > 3);

  // BizFlowNG link validation
  r = await req('POST', '/api/bizflow/link', { token, body: {} });
  check('link requires fields', r.status === 400);
  r = await req('POST', '/api/bizflow/link', { token, body: { businessId: 'biz-1', apiKey: 'short' } });
  check('link rejects short key', r.status === 400);
  r = await req('POST', '/api/bizflow/link', { token, body: { businessId: 'biz-1', apiKey: 'bizflow-key-1234567890', baseUrl: 'http://127.0.0.1:3999' } });
  check('link stored (unverified when instance unreachable)', r.status === 200 && r.json.key_fingerprint);
  r = await req('GET', '/api/bizflow/link', { token });
  check('link status readable, key never returned', r.json.linked === true && !JSON.stringify(r.json).includes('bizflow-key-1234567890'));
  r = await req('DELETE', '/api/bizflow/link', { token });
  check('unlink works', r.status === 200);

  // Sync without completed txn / without link must be rejected
  r = await req('POST', '/api/bizflow/sync', { token, body: { reference: 'TF-X' } });
  check('sync rejects unknown txn', r.status === 404 || r.status === 409);

  // Support escalation
  r = await req('POST', '/api/support/escalate', { token, body: { subject: 'Payment stuck', message: 'My wallet top-up is pending', reference: '' } });
  check('escalation creates ticket', r.status === 201 && r.json.ticket_id);
  r = await req('POST', '/api/support/escalate', { token, body: { subject: '' } });
  check('escalation validates subject', r.status === 400);

  // Renewals + dormant + audit endpoints
  r = await req('GET', '/api/internal/renewals/upcoming', { key: KEY });
  check('renewals endpoint', r.status === 200);
  r = await req('GET', '/api/internal/customers/dormant', { key: KEY });
  check('dormant endpoint', r.status === 200);
  r = await req('GET', '/api/internal/audit?limit=5', { key: KEY });
  check('audit tail', r.status === 200 && r.json.audit.length >= 1);
  r = await req('GET', '/api/internal/bizflow/syncs', { key: KEY });
  check('bizflow sync queue endpoint', r.status === 200);

  receiver.close();
  console.log(results.join('\n'));
  console.log(results.every((l) => l.startsWith('PASS')) ? '\nALL SMOKE TESTS PASSED' : '\nSMOKE FAILURES PRESENT');
})().catch((e) => { console.error('SMOKE CRASHED:', e.message); process.exit(1); });
