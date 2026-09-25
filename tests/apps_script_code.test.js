// Runs the ACTUAL apps-script/Code.gs against stubbed Apps Script globals
// (an in-memory fake spreadsheet), so this tests the real deliverable file,
// not a reimplementation of its logic. Never touches script.google.com or
// any real Google Sheet — run with: node tests/apps_script_code.test.js
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');

function makeFakeSpreadsheet(initial) {
  const sheets = initial || {}; // name -> array of rows (row 0 = header)
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
      setName: (newName) => { sheets[newName] = sheets[name]; delete sheets[name]; name = newName; },
      clear: () => { sheets[name].length = 0; },
      getDataRange: () => ({ getValues: () => sheets[name].map(r => r.slice()) }),
      getLastRow: () => sheets[name].length,
      getRange: (row1, col1, numRows) => ({
        setValues: (values) => {
          for (let i = 0; i < numRows; i++) sheets[name][row1 - 1 + i] = values[i].slice();
        },
        setValue: (v) => { sheets[name][row1 - 1][col1 - 1] = v; },
      }),
    };
  }
}

function loadCodeGs(fakeSpreadsheet) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'Code.gs'), 'utf8');
  const cacheStore = {};
  const sandbox = {
    SpreadsheetApp: { getActiveSpreadsheet: () => fakeSpreadsheet },
    ContentService: {
      MimeType: { JSON: 'JSON' },
      createTextOutput: (text) => ({ _text: text, setMimeType: function () { return this; } }),
    },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (k in cacheStore ? cacheStore[k] : null),
        put: (k, v) => { cacheStore[k] = v; },
      }),
    },
    LockService: { getScriptLock: () => ({ waitLock: () => {}, releaseLock: () => {} }) },
    Utilities: {
      formatDate: (d) => d.toISOString().slice(0, 10),
      DigestAlgorithm: { SHA_256: 'sha256' },
      // Apps Script returns signed bytes (-128..127); mimic that exactly.
      computeDigest: (alg, value) => Array.from(crypto.createHash(alg).update(value).digest()).map(b => (b > 127 ? b - 256 : b)),
    },
    Session: { getScriptTimeZone: () => 'UTC' },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'Code.gs' });
  return sandbox;
}

const TOKEN = 'test-shared-token';
const PHONE_A = 'a'.repeat(64);
const PHONE_B = 'b'.repeat(64);

function freshSandbox(initialSheets) {
  const sb = loadCodeGs(makeFakeSpreadsheet(initialSheets));
  sb.SHARED_TOKEN = TOKEN;
  return sb;
}
function post(sb, payload) {
  return JSON.parse(sb.doPost({ postData: { contents: JSON.stringify(payload) } })._text);
}
function register(sb, hn, device) {
  return post(sb, { token: TOKEN, hn, deviceToken: device, surgeryDate: '2026-01-01', consent: true });
}
function checkin(sb, hn, device, date, extra) {
  return post(sb, Object.assign({
    token: TOKEN, type: 'checkin', hn, deviceToken: device, date: date || '2026-01-05', submittedAt: 't',
    surgeryDate: '2026-01-01', phase: 'p', painScore: 3, exercisesDoneCount: 1, exercisesTotalCount: 2, exercisesDoneNames: 'x',
  }, extra || {}));
}
function tab(sb, name) { return sb.SpreadsheetApp.getActiveSpreadsheet()._sheets[name]; }
function col(sb, name) { return sb.CHECKIN_COLUMNS.indexOf(name); }

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  -', name); passed++; }
  catch (e) { console.log('  FAIL -', name, '\n       ', e.message); failed++; }
}

console.log('Backend logic tests (against real Code.gs, stubbed Apps Script services)\n');

test('rejects requests with the wrong shared token', () => {
  const res = post(freshSandbox(), { token: 'wrong', hn: 'HN1', deviceToken: PHONE_A });
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /invalid token/);
});

test('rejects an invalid hn', () => {
  const res = register(freshSandbox(), '<script>', PHONE_A);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /hn/);
});

test('rejects a malformed deviceToken', () => {
  const res = register(freshSandbox(), '1234567', 'not-hex');
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /deviceToken/);
});

test('any patient with an HN can register — no pre-enrollment or code needed', () => {
  const sb = freshSandbox();
  const res = register(sb, '1234567', PHONE_A);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'registered');
  assert.strictEqual(tab(sb, 'Registrations').length, 2);
});

test('re-registering from the same phone updates instead of duplicating', () => {
  const sb = freshSandbox();
  register(sb, '1234567', PHONE_A);
  const res = register(sb, '1234567', PHONE_A);
  assert.strictEqual(res.action, 'updated');
  assert.strictEqual(res.devices, 1);
  assert.strictEqual(tab(sb, 'Registrations').length, 2);
});

test('a check-in is accepted even if the registration request never arrived', () => {
  const sb = freshSandbox();
  const res = checkin(sb, '1234567', PHONE_A);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.action, 'inserted');
  assert.strictEqual(tab(sb, 'Registrations').length, 2, 'the phone should be recorded too');
});

test('a retry from the same phone for the same day merges into one row', () => {
  const sb = freshSandbox();
  const first = checkin(sb, '1234567', PHONE_A);
  const retry = checkin(sb, '1234567', PHONE_A);
  assert.strictEqual(retry.action, 'merged');
  assert.strictEqual(retry.row, first.row);
  assert.strictEqual(tab(sb, 'CheckIns').length, 2, 'header + exactly one data row');
});

test('a new phone for the same HN is accepted — nobody gets locked out', () => {
  const sb = freshSandbox();
  register(sb, '1234567', PHONE_A);
  const res = register(sb, '1234567', PHONE_B);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.devices, 2);
});

test('a second phone can never overwrite the first phone\'s check-in for the same day', () => {
  const sb = freshSandbox();
  checkin(sb, '1234567', PHONE_A, '2026-01-05', { painScore: 3 });
  const other = checkin(sb, '1234567', PHONE_B, '2026-01-05', { painScore: 0 });
  assert.strictEqual(other.action, 'inserted');
  const rows = tab(sb, 'CheckIns').slice(1);
  assert.strictEqual(rows.length, 2);
  assert.deepStrictEqual(rows.map(r => r[col(sb, 'painScore')]).sort(), [0, 3]);
});

test('once an HN is used from a second phone, all its rows are flagged for staff', () => {
  const sb = freshSandbox();
  checkin(sb, '1234567', PHONE_A, '2026-01-04');
  checkin(sb, '7654321', PHONE_A, '2026-01-04'); // different patient, must stay unflagged
  assert.strictEqual(tab(sb, 'CheckIns')[1][col(sb, 'multipleDevices')], '');
  checkin(sb, '1234567', PHONE_B, '2026-01-05');
  const rows = tab(sb, 'CheckIns').slice(1);
  const flag = (hn) => rows.filter(r => r[0] === hn).map(r => r[col(sb, 'multipleDevices')]);
  assert.ok(flag('1234567').every(f => /YES/.test(f)), 'both rows for the shared HN are flagged');
  assert.deepStrictEqual(flag('7654321'), ['']);
});

test('the full device token is never written to the sheet', () => {
  const sb = freshSandbox();
  checkin(sb, '1234567', PHONE_A);
  const everything = JSON.stringify(sb.SpreadsheetApp.getActiveSpreadsheet()._sheets);
  assert.ok(!everything.includes(PHONE_A));
  const deviceId = tab(sb, 'CheckIns')[1][col(sb, 'deviceId')];
  assert.match(deviceId, /^[0-9a-f]{12}$/);
});

test('a formula-like value is neutralized before it reaches the sheet', () => {
  const sb = freshSandbox();
  checkin(sb, '1234567', PHONE_A, '2026-01-05', { exercisesDoneNames: '=HYPERLINK("http://evil")' });
  assert.strictEqual(String(tab(sb, 'CheckIns')[1][col(sb, 'exercisesDoneNames')]).charAt(0), "'");
});

test('rate limiting kicks in after MAX_REQUESTS_PER_HN_PER_HOUR requests', () => {
  const sb = freshSandbox();
  sb.MAX_REQUESTS_PER_HN_PER_HOUR = 3;
  checkin(sb, '1234567', PHONE_A, '2026-02-01');
  checkin(sb, '1234567', PHONE_A, '2026-02-02');
  checkin(sb, '1234567', PHONE_A, '2026-02-03');
  const fourth = checkin(sb, '1234567', PHONE_A, '2026-02-04');
  assert.strictEqual(fourth.ok, false);
  assert.match(fourth.error, /rate limited/);
});

test('an empty tab left by the previous version gets the new column headings', () => {
  const sb = freshSandbox({ Registrations: [['hn', 'enrollmentCode', 'deviceToken', 'surgeryDate', 'consent', 'registeredAt']] });
  const res = register(sb, '1234567', PHONE_A);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(JSON.stringify(tab(sb, 'Registrations')[0]), JSON.stringify(sb.REGISTRATION_COLUMNS));
});

test('a tab holding data under different headings is moved aside intact and a fresh one started', () => {
  const old = [['Received At', 'Date', 'HN'], ['x', '2026-01-01', '1717']];
  const sb = freshSandbox({ CheckIns: old.map(r => r.slice()), 'CheckIns (old)': [['taken']] });
  const res = checkin(sb, '1234567', PHONE_A);
  assert.strictEqual(res.ok, true, 'the check-in must still be saved');
  assert.strictEqual(JSON.stringify(tab(sb, 'CheckIns (old) 2')), JSON.stringify(old), 'old data kept, under an unused name');
  assert.strictEqual(JSON.stringify(tab(sb, 'CheckIns (old)')), JSON.stringify([['taken']]), 'an existing "(old)" tab is not overwritten');
  assert.strictEqual(JSON.stringify(tab(sb, 'CheckIns')[0]), JSON.stringify(sb.CHECKIN_COLUMNS));
  assert.strictEqual(tab(sb, 'CheckIns').length, 2);
});

test('HN spellings sent straight to the backend are normalized to one key', () => {
  const sb = freshSandbox();
  checkin(sb, 'HN-000123', PHONE_A, '2026-01-04');
  const res = checkin(sb, '๐๐๐๑๒๓', PHONE_B, '2026-01-05');
  assert.strictEqual(res.ok, true);
  const rows = tab(sb, 'CheckIns').slice(1);
  assert.deepStrictEqual(rows.map(r => r[0]), ['000123', '000123']);
  assert.ok(rows.every(r => /YES/.test(r[col(sb, 'multipleDevices')])), 'a second phone under another spelling is still flagged');
  assert.strictEqual(tab(sb, 'Registrations').length, 3, 'one HN, two phones');
});

test('rows left unflagged by an interrupted earlier request are flagged on the next request', () => {
  const sb = freshSandbox();
  checkin(sb, '1234567', PHONE_A, '2026-01-04');
  register(sb, '1234567', PHONE_B);
  // Simulate the flag write having failed after the second phone was recorded.
  const flagCol = col(sb, 'multipleDevices');
  tab(sb, 'CheckIns').slice(1).forEach(r => { r[flagCol] = ''; });
  register(sb, '1234567', PHONE_B); // e.g. the app re-registering at next launch
  assert.ok(tab(sb, 'CheckIns').slice(1).every(r => /YES/.test(r[flagCol])));
});

function ucla(sb, hn, device, week, extra) {
  return post(sb, Object.assign({
    token: TOKEN, type: 'ucla', hn, deviceToken: device, timepointWeek: week, date: '2026-02-01', submittedAt: 't',
    surgeryDate: '2026-01-01', daysPostOp: week * 7,
    pain: 4, 'function': 4, forwardFlexion: null, strength: null, satisfaction: 5, flexionNote: '',
  }, extra || {}));
}
function ucol(sb, name) { return sb.UCLA_COLUMNS.indexOf(name); }

test('a week-2 UCLA questionnaire is saved with unasked items blank and scored by the backend', () => {
  const sb = freshSandbox();
  const res = ucla(sb, '1234567', PHONE_A, 2, { total: 35 }); // a total sent by the phone is ignored
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.total, 13);
  const row = tab(sb, 'UCLA')[1];
  assert.strictEqual(row[ucol(sb, 'total')], 13);
  assert.strictEqual(row[ucol(sb, 'forwardFlexion')], '');
  assert.match(row[ucol(sb, 'grade')], /^Not graded/, 'no grade for a partial scale');
  assert.strictEqual(row[ucol(sb, 'itemsAnswered')], '3 of 5');
});

test('a full week-12 UCLA questionnaire gets the Ellman grade', () => {
  const sb = freshSandbox();
  const res = ucla(sb, '1234567', PHONE_A, 12, { pain: 8, 'function': 8, forwardFlexion: 5, strength: 4, satisfaction: 5 });
  assert.strictEqual(res.total, 30);
  const row = tab(sb, 'UCLA')[1];
  assert.strictEqual(row[ucol(sb, 'grade')], 'Good');
  assert.strictEqual(row[ucol(sb, 'itemsAnswered')], '5 of 5');
});

test('a resent UCLA questionnaire merges into one row per HN + week + phone', () => {
  const sb = freshSandbox();
  ucla(sb, '1234567', PHONE_A, 6);
  const retry = ucla(sb, '1234567', PHONE_A, 6, { pain: 6 });
  assert.strictEqual(retry.action, 'merged');
  ucla(sb, '1234567', PHONE_A, 12);
  assert.strictEqual(tab(sb, 'UCLA').length, 3, 'header + week 6 + week 12');
  assert.strictEqual(tab(sb, 'UCLA')[1][ucol(sb, 'pain')], 6);
});

test('UCLA answers outside the scale, or a wrong week, are refused', () => {
  const sb = freshSandbox();
  assert.strictEqual(ucla(sb, '1234567', PHONE_A, 3).ok, false);
  assert.match(ucla(sb, '1234567', PHONE_A, 2, { pain: 5 }).error, /pain/);
  assert.match(ucla(sb, '1234567', PHONE_A, 2, { satisfaction: 3 }).error, /satisfaction/);
  assert.strictEqual(ucla(sb, '1234567', PHONE_A, 2, { pain: null }).ok, false);
  assert.strictEqual(tab(sb, 'UCLA'), undefined, 'nothing written');
});

test('UCLA rows are flagged too when an HN is used from a second phone', () => {
  const sb = freshSandbox();
  ucla(sb, '1234567', PHONE_A, 2);
  checkin(sb, '1234567', PHONE_B);
  assert.match(tab(sb, 'UCLA')[1][ucol(sb, 'multipleDevices')], /YES/);
});

test('the UCLA tab has plain headings and each answer written out in words', () => {
  const sb = freshSandbox();
  ucla(sb, '1234567', PHONE_A, 6, { forwardFlexion: 0, flexionNote: 'not yet allowed to lift actively' });
  const [header, row] = tab(sb, 'UCLA');
  assert.strictEqual(header[0], 'HN');
  assert.ok(header.includes('Pain — answer') && header.includes('UCLA total (/35)'));
  assert.strictEqual(row[ucol(sb, 'painAnswer')], 'Little or none at rest; pain with light activity');
  assert.match(row[ucol(sb, 'forwardFlexionAnswer')], /Not yet allowed/);
  assert.match(row[ucol(sb, 'strengthAnswer')], /Not asked before week 12/);
  assert.strictEqual(row[ucol(sb, 'satisfactionAnswer')], 'Satisfied — better');
});

test('Patient Summary keeps one up-to-date row per patient', () => {
  const sb = freshSandbox();
  register(sb, '1234567', PHONE_A);
  checkin(sb, '1234567', PHONE_A, '2026-01-05', { painScore: 6 });
  checkin(sb, '1234567', PHONE_A, '2026-01-06', { painScore: 4 });
  ucla(sb, '1234567', PHONE_A, 2);
  ucla(sb, '1234567', PHONE_A, 12, { pain: 8, 'function': 8, forwardFlexion: 5, strength: 4, satisfaction: 5 });
  checkin(sb, '7654321', PHONE_B, '2026-01-06', { painScore: 2 });
  const rows = tab(sb, 'Patient Summary');
  const H = rows[0];
  assert.strictEqual(rows.length, 3, 'header + one row per patient');
  const r = rows.find(x => x[0] === '1234567');
  const v = (h) => r[H.indexOf(h)];
  assert.strictEqual(v('Last check-in'), '2026-01-06');
  assert.strictEqual(v('Latest pain (0–10)'), 4);
  assert.strictEqual(v('Average pain, last 7 check-ins'), 5);
  assert.strictEqual(v('Check-ins sent'), 2);
  assert.strictEqual(v('UCLA week 2 (/35)'), 13);
  assert.strictEqual(v('UCLA week 12 (/35)'), 30);
  assert.strictEqual(v('Latest UCLA grade'), 'Good');
  assert.strictEqual(v('Used on more than one phone?'), '');
});

test('rebuildPatientSummary fills the summary for patients who sent data earlier', () => {
  const sb = freshSandbox();
  checkin(sb, '1234567', PHONE_A);
  delete sb.SpreadsheetApp.getActiveSpreadsheet()._sheets['Patient Summary'];
  sb.rebuildPatientSummary();
  assert.strictEqual(tab(sb, 'Patient Summary').length, 2);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
