// Runs the ACTUAL apps-script/Code.gs against stubbed Apps Script globals
// (an in-memory fake spreadsheet), so this tests the real deliverable file,
// not a reimplementation of its logic. Never touches script.google.com or
// any real Google Sheet — run with: node tests/apps_script_code.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

function makeFakeSpreadsheet() {
  const sheets = {}; // name -> array of rows (row 0 = header)
  return {
    getSheets: () => Object.keys(sheets).map(name => ({ getName: () => name })),
    getSheetByName: (name) => sheets[name] ? makeSheetHandle(name) : null,
    insertSheet: (name) => { sheets[name] = []; return makeSheetHandle(name); },
    _sheets: sheets,
  };

  function makeSheetHandle(name) {
    return {
      appendRow: (row) => { sheets[name].push(row.slice()); },
      setFrozenRows: () => {},
      getDataRange: () => ({ getValues: () => sheets[name].map(r => r.slice()) }),
      getLastRow: () => sheets[name].length,
      getRange: (row1, col1, numRows, numCols) => ({
        setValues: (values) => {
          const rowIdx = row1 - 1;
          for (let i = 0; i < numRows; i++) sheets[name][rowIdx + i] = values[i].slice();
        },
        setValue: (v) => { sheets[name][row1 - 1][col1 - 1] = v; },
      }),
    };
  }
}

function loadCodeGs(fakeSpreadsheet, cacheStore) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => fakeSpreadsheet,
      getUi: () => ({ prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => '' }), Button: { OK: 'OK' } }),
    },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({
        _text: text,
        setMimeType: function () { return this; },
      }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cacheStore ? cacheStore[k] : null),
        put: (k, v) => { cacheStore[k] = v; },
      }),
    },
    Utilities: { formatDate: (d) => d.toISOString().slice(0, 10) },
    Session: { getScriptTimeZone: () => 'UTC' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

function post(sandbox, payloadObj) {
  const result = sandbox.doPost({ postData: { contents: JSON.stringify(payloadObj) } });
  return JSON.parse(result._text);
}

function run() {
  let passed = 0, failed = 0;
  function test(name, fn) {
    try { fn(); console.log('  ok  -', name); passed++; }
    catch (e) { console.log('  FAIL -', name, '\n       ', e.message); failed++; }
  }

  const TOKEN = 'test-shared-token';

  // --- setup: patch SHARED_TOKEN after load since the file hardcodes a placeholder ---
  function freshSandbox() {
    const cache = {};
    const sb = loadCodeGs(makeFakeSpreadsheet(), cache);
    sb.SHARED_TOKEN = TOKEN;
    return sb;
  }

  console.log('Backend logic tests (against real Code.gs, stubbed Apps Script services)\n');

  test('rejects requests with the wrong shared token', () => {
    const sb = freshSandbox();
    const res = post(sb, { token: 'wrong', hn: 'HN1', deviceToken: 'a'.repeat(32) });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /invalid token/);
  });

  test('rejects an invalid hn', () => {
    const sb = freshSandbox();
    const res = post(sb, { token: TOKEN, hn: '<script>', deviceToken: 'a'.repeat(32) });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /hn/);
  });

  test('rejects a malformed deviceToken', () => {
    const sb = freshSandbox();
    const res = post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'not-hex' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /deviceToken/);
  });

  test('first registration for an hn binds its deviceToken', () => {
    const sb = freshSandbox();
    const res = post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.action, 'registered');
  });

  test('a checkin before registration is rejected (hn alone is not enough)', () => {
    const sb = freshSandbox();
    const res = post(sb, { token: TOKEN, type: 'checkin', hn: 'HN1', deviceToken: 'a'.repeat(32), date: '2026-01-05', submittedAt: 't', surgeryDate: '2026-01-01', phase: 'p', painScore: 3, exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not registered/);
  });

  test('unauthorized patient id: checkin with a different device token than the bound one is rejected', () => {
    const sb = freshSandbox();
    post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    const attacker = post(sb, { token: TOKEN, type: 'checkin', hn: 'HN1', deviceToken: 'b'.repeat(32), date: '2026-01-05', submittedAt: 't', surgeryDate: '2026-01-01', phase: 'p', painScore: 3, exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x' });
    assert.strictEqual(attacker.ok, false);
    assert.match(attacker.error, /device token does not match/);
  });

  test('a second registration attempt for the same hn from a different device is rejected (no hijacking an unclaimed... claimed HN)', () => {
    const sb = freshSandbox();
    post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    const hijack = post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'b'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    assert.strictEqual(hijack.ok, false);
    assert.match(hijack.error, /already registered to a different device/);
  });

  test('legitimate checkin from the registered device succeeds', () => {
    const sb = freshSandbox();
    post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    const res = post(sb, { token: TOKEN, type: 'checkin', hn: 'HN1', deviceToken: 'a'.repeat(32), date: '2026-01-05', submittedAt: 't', surgeryDate: '2026-01-01', phase: 'p', painScore: 3, exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x' });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.action, 'inserted');
  });

  test('duplicate retry of the same checkin merges into the same row instead of duplicating', () => {
    const sb = freshSandbox();
    post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    const payload = { token: TOKEN, type: 'checkin', hn: 'HN1', deviceToken: 'a'.repeat(32), date: '2026-01-05', submittedAt: 't', surgeryDate: '2026-01-01', phase: 'p', painScore: 3, exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x' };
    const first = post(sb, payload);
    const retry = post(sb, payload); // simulates the client retrying after e.g. a dropped response
    assert.strictEqual(first.action, 'inserted');
    assert.strictEqual(retry.action, 'merged');
    assert.strictEqual(retry.row, first.row); // same row, not a new one
    const checkinRows = sb.SpreadsheetApp.getActiveSpreadsheet()._sheets['CheckIns'];
    assert.strictEqual(checkinRows.length, 2, 'header + exactly one data row, no duplicate'); // header + 1 row
  });

  test('after device reset, the hn can register again from a new device', () => {
    const sb = freshSandbox();
    post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    sb.resetDeviceToken('HN1');
    const res = post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'b'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    assert.strictEqual(res.ok, true);
  });

  test('a formula-like hn value is neutralized before it reaches the sheet', () => {
    const sb = freshSandbox();
    // hn itself is pattern-restricted so it can't start with '=', but surgeryDate / free-text
    // fields aren't — confirm the sanitizer strips the formula trigger regardless of field.
    const evil = '=HYPERLINK("http://evil")';
    assert.strictEqual(sb.sanitizeForSheet(evil).charAt(0), "'");
    assert.strictEqual(sb.sanitizeForSheet('normal text'), 'normal text');
  });

  test('rate limiting kicks in after MAX_CHECKINS_PER_HN_PER_HOUR requests', () => {
    const sb = freshSandbox();
    sb.MAX_CHECKINS_PER_HN_PER_HOUR = 3;
    post(sb, { token: TOKEN, hn: 'HN1', deviceToken: 'a'.repeat(32), surgeryDate: '2026-01-01', consent: true });
    const mk = (d) => ({ token: TOKEN, type: 'checkin', hn: 'HN1', deviceToken: 'a'.repeat(32), date: d, submittedAt: 't', surgeryDate: '2026-01-01', phase: 'p', painScore: 1, exercisesDoneCount: 0, exercisesTotalCount: 0, exercisesDoneNames: '' });
    post(sb, mk('2026-02-01')); post(sb, mk('2026-02-02')); post(sb, mk('2026-02-03'));
    const fourth = post(sb, mk('2026-02-04'));
    assert.strictEqual(fourth.ok, false);
    assert.match(fourth.error, /rate limited/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
