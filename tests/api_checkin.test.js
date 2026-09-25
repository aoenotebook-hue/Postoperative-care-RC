// Exercises the ACTUAL api/checkin.js handler in-process, with global fetch
// stubbed so no request ever leaves this machine. Run with:
//   node tests/api_checkin.test.js
'use strict';
const assert = require('assert');
const handler = require('../api/checkin.js');

function makeReq(method, body) { return { method, body }; }
function makeRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => { res.body = obj; return res; };
  res.setHeader = () => {};
  return res;
}

async function run() {
  let passed = 0, failed = 0;
  async function test(name, fn) {
    try { await fn(); console.log('  ok  -', name); passed++; }
    catch (e) { console.log('  FAIL -', name, '\n       ', e.stack || e.message); failed++; }
  }

  const hn = 'HN1', token = 'a'.repeat(32);
  const validCheckin = {
    type: 'checkin', hn, deviceToken: token, date: '2026-01-05', submittedAt: '2026-01-05T00:00:00Z',
    surgeryDate: '2026-01-01', phase: 'Phase 1', painScore: 3,
    exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x',
  };

  await test('rejects non-POST methods', async () => {
    const res = makeRes();
    await handler(makeReq('GET', {}), res);
    assert.strictEqual(res.statusCode, 405);
    assert.strictEqual(res.body.ok, false);
  });

  await test('reports backend-not-configured instead of pretending success when env vars are unset', async () => {
    delete process.env.APPS_SCRIPT_URL; delete process.env.APPS_SCRIPT_TOKEN;
    const res = makeRes();
    await handler(makeReq('POST', validCheckin), res);
    assert.strictEqual(res.statusCode, 503);
    assert.strictEqual(res.body.ok, false);
  });

  process.env.APPS_SCRIPT_URL = 'https://script.google.test/exec';
  process.env.APPS_SCRIPT_TOKEN = 'server-only-secret';

  await test('rejects an invalid hn before ever contacting the backend', async () => {
    let called = false;
    global.fetch = async () => { called = true; };
    const res = makeRes();
    await handler(makeReq('POST', Object.assign({}, validCheckin, { hn: '<script>' })), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(called, false, 'must not forward an invalid payload upstream');
  });

  await test('rejects a malformed deviceToken', async () => {
    const res = makeRes();
    await handler(makeReq('POST', Object.assign({}, validCheckin, { deviceToken: 'nope' })), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('rejects an out-of-range painScore', async () => {
    const res = makeRes();
    await handler(makeReq('POST', Object.assign({}, validCheckin, { painScore: 99 })), res);
    assert.strictEqual(res.statusCode, 400);
  });

  await test('never lets the client-supplied token field override the server-held secret', async () => {
    let forwardedBody = null;
    global.fetch = async (url, opts) => { forwardedBody = JSON.parse(opts.body); return { ok: true, text: async () => JSON.stringify({ ok: true }) }; };
    const res = makeRes();
    await handler(makeReq('POST', Object.assign({}, validCheckin, { token: 'attacker-supplied' })), res);
    assert.strictEqual(forwardedBody.token, 'server-only-secret');
  });

  await test('relays a rejected-upload response from the backend as-is (readable, not swallowed)', async () => {
    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ ok: false, error: 'device token does not match' }) });
    const res = makeRes();
    await handler(makeReq('POST', validCheckin), res);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /device token/);
  });

  await test('treats an unreachable backend as a clear failure, not a silent success', async () => {
    global.fetch = async () => { throw new Error('network down'); };
    const res = makeRes();
    await handler(makeReq('POST', validCheckin), res);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.statusCode, 502);
  });

  await test('sanitizes a formula-like field before forwarding upstream', async () => {
    let forwardedBody = null;
    global.fetch = async (url, opts) => { forwardedBody = JSON.parse(opts.body); return { ok: true, text: async () => JSON.stringify({ ok: true }) }; };
    const res = makeRes();
    await handler(makeReq('POST', Object.assign({}, validCheckin, { exercisesDoneNames: '=HYPERLINK("http://evil")' })), res);
    assert.strictEqual(forwardedBody.exercisesDoneNames.charAt(0), "'");
  });

  await test('a valid checkin is forwarded and the backend ack relayed back', async () => {
    global.fetch = async () => ({ ok: true, text: async () => JSON.stringify({ ok: true, action: 'inserted' }) });
    const res = makeRes();
    await handler(makeReq('POST', validCheckin), res);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.action, 'inserted');
  });

  const validRegistration = { hn, deviceToken: token, surgeryDate: '2026-01-01', consent: true };

  await test('forwards a registration with just an HN — no code required', async () => {
    let forwardedBody = null;
    global.fetch = async (url, opts) => { forwardedBody = JSON.parse(opts.body); return { ok: true, text: async () => JSON.stringify({ ok: true, action: 'registered' }) }; };
    const res = makeRes();
    await handler(makeReq('POST', validRegistration), res);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(forwardedBody.hn, hn);
    assert.strictEqual(forwardedBody.type, undefined);
    assert.strictEqual(forwardedBody.token, 'server-only-secret');
  });

  await test('rejects an empty hn before contacting the backend', async () => {
    let called = false;
    global.fetch = async () => { called = true; };
    const res = makeRes();
    await handler(makeReq('POST', Object.assign({}, validRegistration, { hn: '' })), res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(called, false);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
