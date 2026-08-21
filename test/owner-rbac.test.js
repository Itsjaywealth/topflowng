'use strict';

/**
 * TopFlowNG — Owner RBAC authorization tests.
 *
 * Verifies the ownerMiddleware contract without a database: the allow-list
 * logic lives in config + middleware, so we exercise the real middleware with
 * stubbed db/security modules.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'owner-rbac-test-secret';
process.env.OWNER_EMAILS = 'owner@example.com,second@example.com';

const jwt = require('jsonwebtoken');
const config = require('../config');

// Stub the modules ownerMiddleware depends on BEFORE requiring it.
const { createRequire } = require('module');
const Module = require('module');
const origLoad = Module._load;
Module._load = function patched(request, parent, isMain) {
  if (request === '../database') {
    return {
      findUserById: async (id) => {
        const rows = {
          '1': { id: 1, email: 'owner@example.com', is_admin: true },
          '2': { id: 2, email: 'plainadmin@example.com', is_admin: true },
          '3': { id: 3, email: 'owner@example.com', is_admin: false },
          '4': { id: 4, email: 'customer@example.com', is_admin: false },
        };
        return rows[String(id)] || null;
      },
    };
  }
  if (request === '../services/security') {
    return { isTokenRevoked: () => false };
  }
  return origLoad(request, parent, isMain);
};

const { ownerMiddleware } = require('../middleware/auth');

function makeReq(token) {
  return { headers: { authorization: token ? `Bearer ${token}` : '' } };
}
function makeRes() {
  const res = { statusCode: null, body: null };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  return res;
}
function tokenFor(id, email) {
  return jwt.sign({ id, email }, config.jwt.secret, { expiresIn: '1h' });
}

test('owner email + admin passes and sets req.isOwner', async () => {
  const req = makeReq(tokenFor(1, 'owner@example.com'));
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, true);
  assert.equal(req.isOwner, true);
});

test('second allow-listed owner passes', async () => {
  const req = makeReq(tokenFor(1, 'second@example.com'));
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, true);
});

test('admin NOT on the allow-list is rejected with 403', async () => {
  const req = makeReq(tokenFor(2, 'plainadmin@example.com'));
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
});

test('non-admin account with owner email is rejected with 403', async () => {
  const req = makeReq(tokenFor(3, 'owner@example.com'));
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
});

test('ordinary customer is rejected with 403', async () => {
  const req = makeReq(tokenFor(4, 'customer@example.com'));
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 403);
});

test('missing token is rejected with 401', async () => {
  const req = makeReq(null);
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 401);
});

test('tampered token is rejected with 401', async () => {
  const good = tokenFor(1, 'owner@example.com');
  const req = makeReq(good.slice(0, -2) + 'xx');
  const res = makeRes();
  let next = false;
  await ownerMiddleware(req, res, () => { next = true; });
  assert.equal(next, false);
  assert.equal(res.statusCode, 401);
});
