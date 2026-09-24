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
  const alerts = [];
  const sandbox = {
    SpreadsheetApp: {
      getActiveSpreadsheet: () => fakeSpreadsheet,
      getUi: () => ({
        prompt: () => ({ getSelectedButton: () => 'OK', getResponseText: () => '' }),
        alert: (msg) => { alerts.push(msg); },
        Button: { OK: 'OK' },
      }),
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
    Math, // preRegisterPatient/resetDeviceToken generate a random code with Math.random
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  sandbox._alerts = alerts;
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

  function freshSandbox() {
    const cache = {};
    const sb = loadCodeGs(makeFakeSpreadsheet(), cache);
    sb.SHARED_TOKEN = TOKEN;
    return sb;
  }

  // Simulates a clinic staff member enrolling a patient BEFORE they ever open
  // the app, and returns the code that would be handed to that patient.
  function enroll(sb, hn) {
    return sb.preRegisterPatient(hn);
  }

  function register(sb, hn, deviceToken, code) {
    return post(sb, { token: TOKEN, hn, deviceToken, enrollmentCode: code || '', surgeryDate: '2026-01-01', consent: true });
  }

  function checkin(sb, hn, deviceToken, date) {
    return post(sb, { token: TOKEN, type: 'checkin', hn, deviceToken, date: date || '2026-01-05', submittedAt: 't', surgeryDate: '2026-01-01', phase: 'p', painScore: 3, exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x' });
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

  // --- the core fix for the hijacking finding ---

  test('SECURITY: registering an hn nobody at the clinic pre-enrolled is rejected outright — knowing/guessing an hn claims nothing', () => {
    const sb = freshSandbox();
    const attacker = register(sb, 'HN-NEVER-ENROLLED', 'a'.repeat(32), 'anything');
    assert.strictEqual(attacker.ok, false);
    assert.match(attacker.error, /not recognized/);
  });

  test('SECURITY: an attacker who knows a real (but not-yet-claimed) hn cannot register it without the enrollment code', () => {
    const sb = freshSandbox();
    enroll(sb, 'HN1'); // clinic pre-enrolls the real patient's hn
    const attacker = register(sb, 'HN1', 'c'.repeat(32), 'GUESSED-CODE');
    assert.strictEqual(attacker.ok, false);
    assert.match(attacker.error, /invalid enrollment code/);
    // and the real patient can still claim it afterwards with the real code:
    const code = sb.SpreadsheetApp.getActiveSpreadsheet()._sheets['Registrations'][1][1];
    const patient = register(sb, 'HN1', 'a'.repeat(32), code);
    assert.strictEqual(patient.ok, true);
  });

  test('the clinic-issued code claims the pre-enrolled hn and binds this device', () => {
    const sb = freshSandbox();
    const code = enroll(sb, 'HN1');
    const res = register(sb, 'HN1', 'a'.repeat(32), code);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.action, 'registered');
  });

  test('a checkin before registration is rejected (hn alone is not enough)', () => {
    const sb = freshSandbox();
    enroll(sb, 'HN1');
    const res = checkin(sb, 'HN1', 'a'.repeat(32));
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /not registered/);
  });

  test('unauthorized patient id: checkin with a different device token than the bound one is rejected', () => {
    const sb = freshSandbox();
    const code = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), code);
    const attacker = checkin(sb, 'HN1', 'b'.repeat(32));
    assert.strictEqual(attacker.ok, false);
    assert.match(attacker.error, /device token does not match/);
  });

  test('a second registration attempt for the same hn from a different device (even with the right code) is rejected once claimed', () => {
    const sb = freshSandbox();
    const code = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), code);
    const hijack = register(sb, 'HN1', 'b'.repeat(32), code);
    assert.strictEqual(hijack.ok, false);
    assert.match(hijack.error, /already registered to a different device/);
  });

  test('legitimate checkin from the registered device succeeds', () => {
    const sb = freshSandbox();
    const code = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), code);
    const res = checkin(sb, 'HN1', 'a'.repeat(32));
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.action, 'inserted');
  });

  test('the same already-bound device can re-register (e.g. edited surgery date) without re-entering the code', () => {
    const sb = freshSandbox();
    const code = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), code);
    const res = register(sb, 'HN1', 'a'.repeat(32), 'wrong-or-blank-code-should-not-matter-now');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.action, 'updated');
  });

  test('duplicate retry of the same checkin merges into the same row instead of duplicating', () => {
    const sb = freshSandbox();
    const code = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), code);
    const first = checkin(sb, 'HN1', 'a'.repeat(32), '2026-01-05');
    const retry = checkin(sb, 'HN1', 'a'.repeat(32), '2026-01-05'); // simulates a client retry
    assert.strictEqual(first.action, 'inserted');
    assert.strictEqual(retry.action, 'merged');
    assert.strictEqual(retry.row, first.row); // same row, not a new one
    const checkinRows = sb.SpreadsheetApp.getActiveSpreadsheet()._sheets['CheckIns'];
    assert.strictEqual(checkinRows.length, 2, 'header + exactly one data row, no duplicate');
  });

  test('after device reset, the old enrollment code stops working and a fresh one is required', () => {
    const sb = freshSandbox();
    const oldCode = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), oldCode);
    sb.resetDeviceToken('HN1');

    const withOldCode = register(sb, 'HN1', 'b'.repeat(32), oldCode);
    assert.strictEqual(withOldCode.ok, false, 'the old code must be invalidated by a reset');

    const newCode = sb.SpreadsheetApp.getActiveSpreadsheet()._sheets['Registrations'][1][1];
    assert.notStrictEqual(newCode, oldCode);
    const withNewCode = register(sb, 'HN1', 'b'.repeat(32), newCode);
    assert.strictEqual(withNewCode.ok, true);
  });

  test('a formula-like value is neutralized before it reaches the sheet', () => {
    const sb = freshSandbox();
    const evil = '=HYPERLINK("http://evil")';
    assert.strictEqual(sb.sanitizeForSheet(evil).charAt(0), "'");
    assert.strictEqual(sb.sanitizeForSheet('normal text'), 'normal text');
  });

  test('rate limiting kicks in after MAX_CHECKINS_PER_HN_PER_HOUR requests', () => {
    const sb = freshSandbox();
    sb.MAX_CHECKINS_PER_HN_PER_HOUR = 3;
    const code = enroll(sb, 'HN1');
    register(sb, 'HN1', 'a'.repeat(32), code);
    checkin(sb, 'HN1', 'a'.repeat(32), '2026-02-01');
    checkin(sb, 'HN1', 'a'.repeat(32), '2026-02-02');
    checkin(sb, 'HN1', 'a'.repeat(32), '2026-02-03');
    const fourth = checkin(sb, 'HN1', 'a'.repeat(32), '2026-02-04');
    assert.strictEqual(fourth.ok, false);
    assert.match(fourth.error, /rate limited/);
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

run();
