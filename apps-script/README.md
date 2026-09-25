# Backend setup

The app talks to `api/checkin.js` (a same-origin serverless function on
Vercel), which forwards to a Google Apps Script Web App backed by a Google
Sheet. Nothing in this repo's client-side code (`index.html`) holds a real
credential — the Apps Script URL and shared token live only as Vercel
environment variables.

## 1. Deploy the Apps Script backend

1. Open the Google Sheet you want check-ins to land in.
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
   `{"ok":true,"service":"postoperative-care-rc",...}`. If the version doesn't
   match the one in `Code.gs`, step 5 didn't take — redeploy.
9. From the Apps Script editor, run `setUpSheets` once (Run menu > select
   the function > Run) to create the `Registrations`, `CheckIns` and `UCLA`
   tabs. (Skipping this is fine too — each tab is created the first time
   something is written to it.)
   Tabs left empty by an earlier version get the new column headings
   automatically. A tab that already holds data under different headings is
   renamed to e.g. "CheckIns (old)" with its data untouched, and a fresh tab
   is started — nothing is deleted, and check-ins keep flowing even if you
   skip this step.

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

## How patients get in

Nothing for staff to do. A patient opens the app, enters their surgery date
and HN, agrees to the privacy notice, and they're in. Their phone registers
itself in the `Registrations` tab and every check-in lands in `CheckIns`.

- **New phone or reinstall:** just set the app up again with the same HN.
  Nobody is ever locked out.
- **HN typed loosely** ("HN 1234567", "hn:1234567", Thai digits): the app
  stores one standard form, so the same patient's rows line up.
- **`deviceId` column:** a short fingerprint of the phone that sent each row
  (never the phone's actual secret token).

### The tradeoff, and the `multipleDevices` column

Without a clinic-issued code, the app cannot prove that the person typing an
HN is that patient. Anyone who knows a patient's HN could submit check-ins
under it from their own phone. To contain that:

- Rows are merged per HN + date + **device**, so one phone can never
  overwrite another phone's check-in.
- As soon as an HN has been used from more than one phone, every row for that
  HN shows **"YES — check with patient"** in `multipleDevices`. Usually it's a
  new phone or a family member's phone; if not, treat those rows with care.

## UCLA shoulder questionnaire (`UCLA` tab)

The app asks each patient to fill in the UCLA shoulder rating scale at
**2, 6, 12 and 24 weeks** after surgery. During each of those weeks (days
14–20, 42–48, 84–90 and 168–174 after the surgery date) it pops up once a day
until it is answered. If the week is missed, the Home screen keeps offering it
for 7 more days, without the popup.

What is asked depends on what the patient is allowed to do at that point:

| Week | Pain | Function | Forward flexion | Strength | Satisfaction |
|---|---|---|---|---|---|
| 2 | ✓ | ✓ | — (arm protected) | — | ✓ |
| 6 | ✓ | ✓ | ✓ (with a "not yet allowed" answer, scored 0) | — | ✓ |
| 12, 24 | ✓ | ✓ | ✓ | ✓ | ✓ |

Items not asked are left blank and count as 0. `Code.gs` works out the
`total` itself (out of 35) rather than trusting the phone. `grade` uses
Ellman's grading for cuff repair (34–35 excellent, 29–33 good, 21–28 fair,
0–20 poor) and is filled in only when all five items were answered.
`itemsAnswered` shows how many were asked, and `flexionNote` records why
flexion is blank or 0 at weeks 2 and 6. A resend from the same phone updates
its row (one row per HN + week + phone).

## Formula injection

Both `api/checkin.js` and `Code.gs` strip a leading `=`, `+`, `-`, or `@`
from any text value before it reaches a cell, since Sheets (and Excel) treat
those as the start of a formula.

## What this backend does *not* do

- **Verify identity.** See the tradeoff above.
- **Real rate limiting.** `Code.gs` caps requests per HN per hour using Apps
  Script's `CacheService` — best-effort, not a substitute for a proper rate
  limiter (e.g. Vercel KV / Upstash) in front of `api/checkin.js`.
- **Encryption at rest.** Data in the Google Sheet is only as protected as
  the Sheet's own sharing settings (see step 3 above).
