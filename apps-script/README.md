# Backend setup

The app talks to `api/checkin.js` (a same-origin serverless function on
Vercel), which forwards to a Google Apps Script Web App backed by a Google
Sheet. Nothing in this repo's client-side code (`index.html`) holds a real
credential — the Apps Script URL and shared token live only as Vercel
environment variables.

## 1. Deploy the Apps Script backend

1. Create (or open) the Google Sheet you want check-ins to land in.
2. Extensions > Apps Script.
3. Delete the default content and paste in `apps-script/Code.gs` from this
   repo.
4. Replace `SHARED_TOKEN`'s placeholder value with a long random string
   (e.g. generate one with `openssl rand -hex 32`). This is the value you
   will also set as `APPS_SCRIPT_TOKEN` in Vercel below — **do not reuse a
   token from another app or commit the real value to this repo.**
5. Deploy > Manage deployments > pencil icon > Version: **New version** >
   Deploy. (Saving the file alone does not update the live URL.)
6. Set access to **Anyone** (not "Anyone with a Google account" — that
   returns a login page the app can't follow).
7. Copy the deployed `/exec` URL.
8. Open that URL directly in a browser. You should see
   `{"ok":true,"service":"postoperative-care-rc",...}`. If it doesn't match
   the version in `Code.gs`, step 5 didn't take — redeploy.
9. From the Apps Script editor, run `setUpSheets` once (Run menu > select
   the function > Run) to create the `Registrations` and `CheckIns` tabs.

## 2. Configure Vercel

In the Vercel project's Settings > Environment Variables, add:

| Name | Value |
|---|---|
| `APPS_SCRIPT_URL` | the `/exec` URL from step 7 above |
| `APPS_SCRIPT_TOKEN` | the same random string you put in `SHARED_TOKEN` |

Redeploy after setting these — `api/checkin.js` reads them at request time
and returns `{"ok":false,"error":"backend not configured"}` until they're
set, so check-ins stay safely queued on-device rather than silently failing.

## 3. Restrict the Google Sheet itself

The token above stops anonymous internet traffic, not someone who already
has edit access to the Sheet. Share it only with people who need it, and
prefer "Restricted" sharing over "Anyone with the link."

## 4. Enroll each patient *before* they open the app

The app can't just let whoever opens it first claim an HN — anyone who
knows or guesses a real HN would then be able to register it before the
actual patient does, submit fake check-ins under it, and lock the real
patient out. So an HN has to exist in the `Registrations` sheet, with a
code only the clinic knows, before a device is allowed to claim it:

1. Open the Apps Script editor for this project.
2. Select `preRegisterPatient` from the function dropdown, click Run.
3. Enter the patient's HN when prompted.
4. A dialog shows an enrollment code (e.g. `4F7K-9QX2`). Give this to the
   patient — verbally, on discharge paperwork, however fits your workflow.
5. The patient enters their HN and this code once, the first time they set
   up the app on their device. After that, their device is remembered and
   they're never asked for the code again (until you reset it — below).

Do this for every patient before telling them the app is ready to use. An
HN nobody has run `preRegisterPatient` for cannot register at all — the app
will tell the patient to contact the clinic.

## Moving a patient to a new device

If a patient reinstalls the app or switches phones, their new device won't
match the token on file, and their old enrollment code will no longer work
either (it's invalidated on reset, see below) — check-ins fail until you
reset them:

1. Open the Apps Script editor for this project.
2. Select `resetDeviceToken` from the function dropdown, click Run.
3. Enter the patient's HN when prompted.
4. A dialog shows a **new** enrollment code — give this to the patient (the
   old one no longer works).
5. The patient enters their HN and the new code on their new device.

## Formula injection

Both `api/checkin.js` and `Code.gs` strip a leading `=`, `+`, `-`, or `@`
from any text value before it reaches a cell, since Sheets (and Excel) treat
those as the start of a formula. This is defense in depth — it's enforced in
two places on purpose, since `Code.gs` is the actual point of no return.

## What this backend does *not* do

- **Real rate limiting.** `Code.gs` caps check-ins per HN per hour using
  Apps Script's `CacheService`, which is best-effort within that runtime and
  not a substitute for a proper rate limiter (e.g. Vercel KV / Upstash) in
  front of `api/checkin.js` if this app ever sees real abuse. Not set up
  here — would need a KV store provisioned in the Vercel project.
- **Encryption at rest.** Data in the Google Sheet is only as protected as
  the Sheet's own sharing settings (see step 3 above).
- **A true login system.** The enrollment code plus device-token binding
  stops a remote attacker who only knows/guesses an HN from claiming or
  writing to it, but it is not a password or an account — anyone who gets
  physical/browser access to a registered patient's device, or who
  intercepts their enrollment code before they use it, can act as that
  patient.
