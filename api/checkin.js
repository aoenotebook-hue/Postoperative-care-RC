// Same-origin proxy in front of the Apps Script backend.
//
// Why this exists: the app used to POST straight from the browser to a public
// Apps Script URL with a "secret" baked into this file. That secret shipped to
// every visitor's browser, so it authenticated nobody — anyone who viewed the
// page source could extract it and submit data as any patient. This proxy
// moves the real credentials server-side (Vercel environment variables, never
// sent to the browser) and gives the client a same-origin endpoint it can
// trust: no CORS is involved, so the JSON response is actually readable,
// which lets the client only mark a check-in "synced" once the backend has
// confirmed it was really persisted (Apps Script Web Apps don't reliably send
// CORS headers, so a direct browser fetch to script.google.com can't read the
// response at all — this proxy talks to Apps Script server-to-server, where
// CORS doesn't apply, and relays a clean response back to the client).
//
// Required Vercel environment variables (Project Settings > Environment
// Variables — full setup steps in apps-script/README.md):
//   APPS_SCRIPT_URL    the deployed Apps Script Web App's /exec URL
//   APPS_SCRIPT_TOKEN  must exactly match SHARED_TOKEN in apps-script/Code.gs
//
// This file only validates shape/size and forwards the request. Any patient
// can register by HN; how rows are kept apart per device, and how an HN used
// from several phones is flagged, is handled in Code.gs.

const MAX_BODY_BYTES = 8 * 1024; // a check-in/registration payload is a few hundred bytes; refuse anything absurd
const MAX_STRING_LEN = 500;
const HN_PATTERN = /^[A-Za-z0-9\-/ ]{1,32}$/;
const TOKEN_PATTERN = /^[0-9a-f]{16,128}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// Same rules as normalizeHn() in index.html and Code.gs: "HN 1234567",
// "hn:1234567" and Thai digits all become "1234567", so an older or
// hand-built client can't split one patient across two HN spellings.
function normalizeHn(raw) {
  if (typeof raw !== 'string') return raw;
  return raw
    .replace(/[๐-๙]/g, (d) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(d)))
    .trim()
    .replace(/^HN\s*[:.\-#]?\s*/i, '')
    .replace(/\s+/g, ' ')
    .toUpperCase();
}

function isPlainString(v, maxLen) {
  return typeof v === 'string' && v.length <= (maxLen || MAX_STRING_LEN);
}

// Google Sheets treats a cell starting with = + - @ as a formula. Any string
// field here can originate from a patient-editable input (HN, free text), so
// nothing gets forwarded to the spreadsheet without this guard — defense in
// depth alongside the same check in Code.gs, which is the actual sheet-writer.
function sanitizeForSheet(v) {
  if (typeof v !== 'string') return v;
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function sanitizePayload(payload) {
  const out = {};
  for (const key of Object.keys(payload)) out[key] = sanitizeForSheet(payload[key]);
  return out;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store'); // this response can carry patient data; never cache it

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method not allowed' });
    return;
  }

  const scriptUrl = process.env.APPS_SCRIPT_URL;
  const scriptToken = process.env.APPS_SCRIPT_TOKEN;
  if (!scriptUrl || !scriptToken) {
    // Backend not configured yet — say so plainly rather than pretending success,
    // so the client keeps the record pending instead of losing it silently.
    res.status(503).json({ ok: false, error: 'backend not configured' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
      res.status(413).json({ ok: false, error: 'payload too large' });
      return;
    }
    try { body = JSON.parse(body); } catch { body = null; }
  }
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'invalid JSON body' });
    return;
  }

  const hn = normalizeHn(body.hn);
  const { type, deviceToken, surgeryDate, date, submittedAt, phase, painScore,
          exercisesDoneCount, exercisesTotalCount, exercisesDoneNames, consent } = body;

  if (!isPlainString(hn, 32) || !HN_PATTERN.test(hn)) {
    res.status(400).json({ ok: false, error: 'invalid hn' });
    return;
  }
  if (!isPlainString(deviceToken) || !TOKEN_PATTERN.test(deviceToken)) {
    res.status(400).json({ ok: false, error: 'invalid deviceToken' });
    return;
  }
  if (surgeryDate !== undefined && surgeryDate !== '' && !DATE_PATTERN.test(surgeryDate)) {
    res.status(400).json({ ok: false, error: 'invalid surgeryDate' });
    return;
  }

  let forwardPayload;
  if (type === 'checkin') {
    if (!DATE_PATTERN.test(date || '')) return res.status(400).json({ ok: false, error: 'invalid date' });
    if (!isPlainString(submittedAt, 40)) return res.status(400).json({ ok: false, error: 'invalid submittedAt' });
    if (!isPlainString(phase, 120)) return res.status(400).json({ ok: false, error: 'invalid phase' });
    if (typeof painScore !== 'number' || painScore < 0 || painScore > 10) return res.status(400).json({ ok: false, error: 'invalid painScore' });
    if (typeof exercisesDoneCount !== 'number' || exercisesDoneCount < 0) return res.status(400).json({ ok: false, error: 'invalid exercisesDoneCount' });
    if (typeof exercisesTotalCount !== 'number' || exercisesTotalCount < 0) return res.status(400).json({ ok: false, error: 'invalid exercisesTotalCount' });
    if (!isPlainString(exercisesDoneNames, 2000)) return res.status(400).json({ ok: false, error: 'invalid exercisesDoneNames' });
    forwardPayload = { type: 'checkin', hn, deviceToken, date, submittedAt, surgeryDate, phase, painScore, exercisesDoneCount, exercisesTotalCount, exercisesDoneNames };
  } else if (type === 'ucla') {
    // UCLA shoulder questionnaire. Code.gs checks each answer and computes the total itself.
    const b = body;
    if (![2, 6, 12, 24].includes(b.timepointWeek)) return res.status(400).json({ ok: false, error: 'invalid timepointWeek' });
    if (!DATE_PATTERN.test(date || '')) return res.status(400).json({ ok: false, error: 'invalid date' });
    if (!isPlainString(submittedAt, 40)) return res.status(400).json({ ok: false, error: 'invalid submittedAt' });
    if (typeof b.daysPostOp !== 'number' || b.daysPostOp < 0 || b.daysPostOp > 1000) return res.status(400).json({ ok: false, error: 'invalid daysPostOp' });
    for (const item of ['pain', 'function', 'forwardFlexion', 'strength', 'satisfaction']) {
      const v = b[item];
      if (v !== null && (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 10)) {
        return res.status(400).json({ ok: false, error: 'invalid ' + item });
      }
    }
    if (b.flexionNote !== undefined && !isPlainString(b.flexionNote, 120)) return res.status(400).json({ ok: false, error: 'invalid flexionNote' });
    forwardPayload = {
      type: 'ucla', hn, deviceToken, date, submittedAt, surgeryDate, timepointWeek: b.timepointWeek, daysPostOp: b.daysPostOp,
      pain: b.pain, function: b.function, forwardFlexion: b.forwardFlexion, strength: b.strength,
      satisfaction: b.satisfaction, flexionNote: b.flexionNote || '',
    };
  } else {
    // Registration (no "type", matching the Apps Script convention).
    forwardPayload = { hn, deviceToken, surgeryDate, consent: consent === true };
  }

  forwardPayload = sanitizePayload(forwardPayload);
  forwardPayload.token = scriptToken; // the real, server-only shared token — never sent to the browser

  try {
    const upstream = await fetch(scriptUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids Apps Script's own CORS/preflight quirks
      body: JSON.stringify(forwardPayload),
    });
    const text = await upstream.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* upstream returned something unparseable */ }
    if (!upstream.ok || !json) {
      res.status(502).json({ ok: false, error: 'backend did not return a valid response' });
      return;
    }
    // Relay the backend's own ok/error verdict — this is the "readable upload
    // response" the client waits for before marking a record synced.
    res.status(200).json(json);
  } catch (err) {
    res.status(502).json({ ok: false, error: 'could not reach backend' });
  }
};
