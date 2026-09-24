/**
 * Backend for the post-operative shoulder care app.
 *
 * SECURITY MODEL
 * ---------------
 * `SHARED_TOKEN` below identifies requests as coming from this app's own
 * server-side proxy (api/checkin.js on Vercel) — it is set as an environment
 * variable there and is NEVER shipped to any browser. That alone is not
 * patient authorization, though: it just proves "this came from our proxy,"
 * not "this came from patient X." Patient-scoped authorization is enforced
 * separately, below, by binding each HN to the random device token the
 * app generates for that patient's device on first use (see getDeviceToken()
 * in index.html) — trust-on-first-use, the same model an SSH host key uses.
 * A request for an HN whose token doesn't match the one bound to it is
 * rejected outright, so knowing/guessing an HN is never enough on its own to
 * write or overwrite that patient's data.
 *
 * If a patient gets a new phone or reinstalls the app, their new device
 * generates a new token, which will no longer match what's on file — call
 * resetDeviceToken(hn) below (from the Apps Script editor: Run > select the
 * function > enter the HN in the log/prompt) to let them re-register. This
 * is a deliberate manual step, not a bug: it's what makes the binding mean
 * something.
 *
 * SETUP — do all four steps, the last one matters most:
 *   1. Open your Google Sheet > Extensions > Apps Script.
 *   2. Delete everything in the editor and paste this whole file in. Save.
 *   3. Deploy > Manage deployments > (pencil icon) > Version: New version
 *      > Deploy. Saving alone does NOT update the live /exec URL, which is
 *      why an older copy of this script can keep answering requests.
 *   4. Check it worked: open the /exec URL in a browser. You should see
 *      {"ok":true,"service":"postoperative-care-rc","version":"...", ...}
 *      If the version does not match the one below, step 3 did not take.
 *
 * Access must be "Anyone" (not "Anyone with a Google account"), otherwise
 * Google answers with a login page the app cannot follow.
 *
 * Then set this script's URL and token in Vercel (Project Settings >
 * Environment Variables) as APPS_SCRIPT_URL and APPS_SCRIPT_TOKEN — see
 * apps-script/README.md.
 */

var SCRIPT_VERSION = '2026-09-24';
var SHARED_TOKEN = 'REPLACE_WITH_A_LONG_RANDOM_VALUE_THEN_SET_THE_SAME_VALUE_AS_APPS_SCRIPT_TOKEN_IN_VERCEL';

var MAX_CHECKINS_PER_HN_PER_HOUR = 30; // generous for real use, low enough to blunt a scripted flood

var REGISTRATION_COLUMNS = ['hn', 'deviceToken', 'surgeryDate', 'consent', 'registeredAt'];
var CHECKIN_COLUMNS = ['hn', 'date', 'submittedAt', 'surgeryDate', 'phase', 'painScore',
  'exercisesDoneCount', 'exercisesTotalCount', 'exercisesDoneNames', 'receivedAt'];

function jsonReply(payload) {
  payload.version = SCRIPT_VERSION;
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Health check: open the /exec URL in a browser to confirm what is deployed. */
function doGet() {
  var sheetNames = [];
  try {
    sheetNames = SpreadsheetApp.getActiveSpreadsheet().getSheets().map(function (s) { return s.getName(); });
  } catch (err) {
    return jsonReply({ ok: false, error: 'This script is not bound to a spreadsheet: ' + err });
  }
  return jsonReply({
    ok: true,
    service: 'postoperative-care-rc',
    tokenConfigured: SHARED_TOKEN.indexOf('REPLACE') === -1,
    sheets: sheetNames
  });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return jsonReply({ ok: false, error: 'no request body' });
    }
    var payload = JSON.parse(e.postData.contents);

    if (payload.token !== SHARED_TOKEN) {
      return jsonReply({ ok: false, error: 'invalid token — the proxy and this script are using different APPS_SCRIPT_TOKEN values' });
    }
    if (!validHn(payload.hn)) {
      return jsonReply({ ok: false, error: 'invalid or missing hn' });
    }
    if (!validDeviceToken(payload.deviceToken)) {
      return jsonReply({ ok: false, error: 'invalid or missing deviceToken' });
    }

    if (payload.type === 'checkin') {
      return jsonReply(handleCheckin(payload));
    }
    return jsonReply(handleRegistration(payload));
  } catch (err) {
    return jsonReply({ ok: false, error: String(err) });
  }
}

function validHn(hn) {
  return typeof hn === 'string' && hn.length > 0 && hn.length <= 32 && /^[A-Za-z0-9\-\/ ]+$/.test(hn);
}

function validDeviceToken(token) {
  return typeof token === 'string' && /^[0-9a-f]{16,128}$/.test(token);
}

/** Rejects a request over MAX_CHECKINS_PER_HN_PER_HOUR for the same HN — a scripted-flood guard, not a clinical limit. */
function rateLimited(hn) {
  var cache = CacheService.getScriptCache();
  var key = 'rl_' + hn;
  var count = Number(cache.get(key) || '0') + 1;
  cache.put(key, String(count), 3600); // 1 hour window
  return count > MAX_CHECKINS_PER_HN_PER_HOUR;
}

function ensureSheet(name, columns) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    sheet.appendRow(columns);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function cellToString(value) {
  if (value instanceof Date) return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(value === undefined || value === null ? '' : value);
}

// Google Sheets treats a cell starting with = + - @ as a formula. Every
// string value here can originate from patient input, so nothing is written
// to a cell without this guard.
function sanitizeForSheet(value) {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function rowFor(columns, payload) {
  return columns.map(function (col) {
    if (col === 'receivedAt' || col === 'registeredAt') return new Date();
    return sanitizeForSheet(payload[col] === undefined ? '' : payload[col]);
  });
}

/**
 * Trust-on-first-use: the first registration for a given HN binds that HN to
 * the submitted deviceToken. Every later registration or check-in for the
 * same HN must present the same deviceToken, or it is rejected — this is
 * what makes "hn alone" insufficient to write data.
 */
function handleRegistration(payload) {
  var sheet = ensureSheet('Registrations', REGISTRATION_COLUMNS);
  var columns = REGISTRATION_COLUMNS;
  var data = sheet.getDataRange().getValues();
  var hnCol = columns.indexOf('hn');
  var tokenCol = columns.indexOf('deviceToken');

  for (var r = 1; r < data.length; r++) {
    if (cellToString(data[r][hnCol]) !== cellToString(payload.hn)) continue;
    var boundToken = cellToString(data[r][tokenCol]);
    if (boundToken === '') {
      // Was reset by clinic staff (resetDeviceToken) — this device claims it.
      sheet.getRange(r + 1, 1, 1, columns.length).setValues([rowFor(columns, payload)]);
      return { ok: true, action: 'registered', row: r + 1 };
    }
    if (boundToken !== payload.deviceToken) {
      return { ok: false, error: 'hn already registered to a different device — contact the clinic to reset it' };
    }
    // Same device re-registering (e.g. edited surgery date) — harmless update.
    sheet.getRange(r + 1, 1, 1, columns.length).setValues([rowFor(columns, payload)]);
    return { ok: true, action: 'updated', row: r + 1 };
  }

  sheet.appendRow(rowFor(columns, payload));
  return { ok: true, action: 'registered', row: sheet.getLastRow() };
}

function handleCheckin(payload) {
  var regSheet = ensureSheet('Registrations', REGISTRATION_COLUMNS);
  var regData = regSheet.getDataRange().getValues();
  var regHnCol = REGISTRATION_COLUMNS.indexOf('hn');
  var regTokenCol = REGISTRATION_COLUMNS.indexOf('deviceToken');

  var bound = null;
  for (var r = 1; r < regData.length; r++) {
    if (cellToString(regData[r][regHnCol]) === cellToString(payload.hn)) { bound = cellToString(regData[r][regTokenCol]); break; }
  }
  if (bound === null) {
    return { ok: false, error: 'hn is not registered — the app should register before checking in' };
  }
  if (bound !== payload.deviceToken) {
    return { ok: false, error: 'device token does not match this hn\'s registration' };
  }
  if (rateLimited(payload.hn)) {
    return { ok: false, error: 'rate limited' };
  }

  var sheet = ensureSheet('CheckIns', CHECKIN_COLUMNS);
  var columns = CHECKIN_COLUMNS;
  var data = sheet.getDataRange().getValues();
  var hnCol = columns.indexOf('hn');
  var dateCol = columns.indexOf('date');

  for (var i = 1; i < data.length; i++) {
    if (cellToString(data[i][hnCol]) !== cellToString(payload.hn)) continue;
    if (cellToString(data[i][dateCol]) !== cellToString(payload.date)) continue;
    // Same patient, same day — merge/overwrite rather than append (idempotent retries).
    sheet.getRange(i + 1, 1, 1, columns.length).setValues([rowFor(columns, payload)]);
    return { ok: true, action: 'merged', row: i + 1 };
  }

  sheet.appendRow(rowFor(columns, payload));
  return { ok: true, action: 'inserted', row: sheet.getLastRow() };
}

/**
 * Run this from the Apps Script editor (select resetDeviceToken from the
 * function dropdown, then Run — it will prompt for the HN in a dialog if run
 * from the editor's UI, or edit the hn variable below and run it directly)
 * when a patient needs to switch devices. Clears the bound token so their
 * next registration succeeds.
 */
function resetDeviceToken(hn) {
  if (!hn) {
    var ui = SpreadsheetApp.getUi();
    var resp = ui.prompt('Reset device for which HN?');
    if (resp.getSelectedButton() !== ui.Button.OK) return;
    hn = resp.getResponseText().trim();
  }
  var sheet = ensureSheet('Registrations', REGISTRATION_COLUMNS);
  var data = sheet.getDataRange().getValues();
  var hnCol = REGISTRATION_COLUMNS.indexOf('hn');
  var tokenCol = REGISTRATION_COLUMNS.indexOf('deviceToken');
  for (var r = 1; r < data.length; r++) {
    if (cellToString(data[r][hnCol]) === cellToString(hn)) {
      sheet.getRange(r + 1, tokenCol + 1).setValue('');
      return 'Cleared device token for ' + hn + ' — they can register again on their new device.';
    }
  }
  return 'No registration found for ' + hn;
}

/** Run this once from the editor to create the tabs and confirm access. */
function setUpSheets() {
  ensureSheet('Registrations', REGISTRATION_COLUMNS);
  ensureSheet('CheckIns', CHECKIN_COLUMNS);
  return 'Created/verified: Registrations, CheckIns';
}
