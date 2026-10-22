# Extension — Phases 2 + 3 (test copy)

Owner: Matthew DeMoss — Private / confidential. Do not share.
Location: luna-rebuild/extension/ (rewritten copy of the repo's extension/).
The repo-root extension/ is untouched.

## What was broken (recap)

1. Handshake mismatch: the app sends window.postMessage
   ({type:"AUTOLAUNCH_EXT_LOGIN"}) into the page; the extension waited for
   chrome.runtime.onMessageExternal ({type:"SET_USER_ID"}) — a message a
   web page cannot even address to an extension — and the manifest had no
   content script on the AutoLaunch origin and no externally_connectable.
   Result: the extension never learned the user id; checkQueue always
   exited early. Nothing ever posted.
2. setInterval in an MV3 service worker: workers are killed when idle,
   so the 20s poll died silently.
3. Status mismatch: content.js wrote queue status "completed"; the UI
   knows pending / processing / posted.
4. Dishonest success: content.js waited a fixed 2s and marked the car
   posted regardless of what Facebook did, and set form values with plain
   .value, which React controlled inputs ignore.

## What changed

### manifest.json (v2.0.0)
- Added "alarms" permission.
- Added content script bridge.js on https://mdemoss-bdc.github.io/AutoLaunch/*
- Added externally_connectable for https://mdemoss-bdc.github.io/*
- host_permissions now include the AutoLaunch origin.
- Added host_permission "https://*/*" (photo relay, below): dealer photo
  CDNs live on whatever host each store's site uses, and the background
  worker needs host access to fetch their photos around CORS. The
  worker only fetches a URL when the Facebook content script asks for
  one photo, and only http(s) URLs at that.

### bridge.js (NEW)
- Runs only on the AutoLaunch origin. Listens for the app's
  AUTOLAUNCH_EXT_LOGIN window message (same-window, same-origin only) and
  forwards the userId — and now the session accessToken too — to the
  background worker. The app side speaks first; the bridge meets it where
  it already speaks.

### background.js (rewritten)
- User id arrives via the bridge (onMessage); the legacy onMessageExternal
  SET_USER_ID path is kept as a secondary route.
- SESSION TOKEN (fixes the "queue sits pending forever" bug): the queue,
  settings and inventory tables are RLS-locked to the `authenticated`
  role with auth.uid() owner policies, so the worker's original
  anon-key-only calls could see and claim NOTHING. Flow now: the app
  includes its current Supabase access_token in AUTOLAUNCH_EXT_LOGIN
  (postExtLogin in index.html; re-posted on every TOKEN_REFRESHED /
  SIGNED_IN auth event), the bridge forwards it, and the worker stores
  it in chrome.storage.local and sends `Authorization: Bearer <token>`
  (alongside the publishable `apikey`) on EVERY Supabase REST call —
  queue select/claim, inventory select/update, settings select and the
  daily-limit count all go through sbGet/sbPatch, which build the header
  from storage each time. The token is never logged and never written
  into failure records.
- Expiry behavior: a 401/403 from any call records
  autolaunch_last_error = "session_expired — reopen the AutoLaunch tab"
  and stops claiming (the 1-minute alarm becomes a no-op) until a NEW
  token arrives through the bridge — the dead token is never retried.
  With no token stored yet, cycles skip quietly with a one-time
  "waiting_for_login" note. If a token dies mid-job and the content
  script's posted/failed report can't be written, the finish is stashed
  (autolaunch_pending_finish) and replayed when the fresh token arrives,
  so a confirmed listing is never lost and the row never wedges in
  "processing".
- Polling via chrome.alarms (1 minute) created on install/startup, plus an
  immediate check on install/startup and whenever a user id arrives.
- One status vocabulary with the UI: pending -> processing -> posted/failed.
- Claiming is conditional (PATCH only while status=pending, using
  return=representation) so duplicate claims cannot happen.
- Daily limit enforced in the worker too: counts today's
  marketplace_posted_at on scraped_inventory vs user_settings.daily_post_limit
  before claiming anything (999 = unlimited, matching the app convention).
- One job at a time; human-paced tab opening (1.5–4s jitter).
- The worker NEVER marks posted. Only the content script's confirmed
  success can (via AUTOLAUNCH_JOB_POSTED). Failures are recorded
  (status=failed) with a reason kept in chrome.storage
  (autolaunch_last_error / autolaunch_failure_log) because the queue table
  has no reason column we can rely on.
- Queue rows whose inventory row has vanished are marked failed instead
  of pending forever.
- PHOTO RELAY (fixes the first live test's only failure): the content
  script's direct fetch of dealer photo URLs was CORS-blocked from the
  facebook.com page — dealer photo servers send no
  Access-Control-Allow-Origin (verified for mosescars.com; the same
  wall the web app's photo-proxy Edge Function was built for). The
  content script now sends {type:"AUTOLAUNCH_FETCH_PHOTO", url} here;
  the worker's fetches are extension fetches (host-permitted, not
  page-CORS-bound). Replies are structured: {ok:true, base64,
  contentType} (chunked base64; ~15MB cap; non-200, non-image and empty
  bodies are structured errors), and the handler only serves senders on
  facebook.com. A failed relay falls through to the photo-proxy in the
  content script; only if both fail does the job fail, as before.

### content.js (rewritten)
- React-safe fill: native prototype value setter + input/change events.
- Fields attempted, by label/aria text with a combobox path for
  Facebook's dropdown fields: photos (first), year, make, model, price,
  mileage, condition (New / Certified / Used mapped to FB's labels),
  transmission, body style, description (includes title, price, miles,
  color, transmission, VIN).
- Photos: all known URL fields on the car (image_url, photos, images,
  image_urls, photo_urls; max 10). An upload only counts if a preview
  image actually appears. Failure = banner + job FAILED with reason.
  No more silent continue, and no posting photoless cars by accident.
- Photo BYTES arrive via a two-stage path, never a direct fetch from
  this page (CORS — see the relay note under background.js): stage 1,
  the background relay returns the photo base64 and it is rebuilt into
  a File locally; stage 2, on relay error, the photo-proxy Edge
  Function (same publishable apikey the app uses; returns CORS *).
  The DataTransfer/input.files upload and preview check after that are
  unchanged.
- Visible banner at the top of the page narrates every step.
- Login wall / checkpoint / "confirm your identity" = immediate FAILED
  with a plain-language reason. The script never types into a checkpoint.
- CONFIRM MODE (default ON): fills everything, then stops. The human
  reviews and clicks Publish; the script watches up to 10 minutes for a
  real success state. Full-auto: set autolaunch_confirm_mode=false in the
  extension's chrome.storage; then the script advances "Next" steps and
  clicks Publish itself.
- POSTED only on detected success: navigation to a marketplace item /
  selling URL, or on-page text like "your listing is now live". Timeout
  or anything else = FAILED with the reason. There is no timer that
  declares success.

## How to test it (Matthew)

1. In Chrome: chrome://extensions -> Developer mode ON -> Load unpacked ->
   select this folder once it is in your local clone of the repo
   (luna-rebuild/extension/).
2. Open the AutoLaunch TEST app (…/AutoLaunch/luna-rebuild/) and sign in
   (or, after reloading the extension, hard-refresh the app tab). The
   bridge hands your user id AND your Supabase session token to the
   extension automatically — the worker can't see your queue without
   the token, and it re-receives a fresh one whenever yours rotates.
   If the extension ever reports "session_expired", reopening /
   refreshing this tab is the fix.
3. Queue one car (marketplace channel). Within about a minute a Facebook
   "Create vehicle" tab opens and the filler runs with the blue banner.
4. Review the filled form. In confirm mode, click Publish yourself; the
   queue row should flip to Posted only after Facebook confirms, and the
   car gets marketplace_posted_at in the app.
5. To see failures honestly: queue a car while logged out of Facebook —
   the job should end Failed with the login reason, never Posted.

## Live test log

- 2026-10-22, first end-to-end run: handshake, session token, queue
  claim, Facebook tab and form fill all worked. The job failed at
  exactly one step — photo upload, "photo_download_failed" — because
  the content script's direct fetch of the dealer photo was
  CORS-blocked (root cause verified, see the photo relay notes). The
  relay → photo-proxy path above is the fix; it is the one piece of
  this build that has NOT yet had a live Facebook run. Re-test: reload
  the extension at the same folder (Reload on its card; same folder =
  same extension ID), hard-refresh the app tab, re-queue the car (a
  FAILED row can be queued again).

## Honest limits (untested overnight)

- Not run against live Facebook: DOM selectors/labels are best-effort
  heuristics against Facebook's current vehicle-create flow, which changes
  often. First real test may need selector tweaks — the failure reasons
  and banner will say exactly where it got stuck.
- RESOLVED (was: "Supabase calls use the publishable key without a user
  JWT"): the session-token flow described under background.js above is
  live — app → bridge → worker storage → Authorization header on every
  call, refresh re-posts from the app's auth listener, and a dead token
  stops claiming instead of silently failing against RLS. One residual
  truth: the token is the user's own short-lived Supabase session token
  (rotated roughly hourly by Supabase); it lives only in the extension's
  chrome.storage.local on the user's machine, never on a server of ours.
- Facebook may treat any automation as a policy risk. Confirm mode +
  daily caps + human pacing reduce, not eliminate, that risk.
